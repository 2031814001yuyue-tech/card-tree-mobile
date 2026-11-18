package com.cardtree.mobile;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 网页层热更新：从 GitHub Releases 检查并安装新的网页包。
 *
 * <p>约定：仓库里每个 tag 形如 {@code web-v0.3.5} 的 Release 是一个网页层版本，
 * 附带两个资产：{@code web.zip}（rspack 构建产物打包）和 {@code web.zip.sha256}（哈希）。
 *
 * <p>安装流程：下载 zip → 校验 sha256 → 解压到 web-staging/ → 验证 index.html →
 * 删掉旧 web/ 目录、把 staging 改名成 web → 记下版本号。{@link MainActivity} 传给
 * {@link LocalServer} 的 AssetSource 优先读 files/web/，读不到再回 APK 内置的
 * assets/www，所以：更新失败或从没更新过时永远用内置版本，App 不会因为更新而变砖。
 *
 * <p>纯 JDK 实现，不依赖 Android 类，可以在桌面 JVM 上单独跑测试。
 */
public final class WebUpdater {

    /** 安装进度回调；报告给用户看的短句。 */
    public interface Progress {
        void report(String text);
    }

    /** 一次可用的网页层更新。 */
    public static final class UpdateInfo {
        public final String version;
        public final String tag;
        public final String zipUrl;
        public final String sha256Url;
        public final String notes;
        public final long zipSize;

        UpdateInfo(String version, String tag, String zipUrl, String sha256Url,
                String notes, long zipSize) {
            this.version = version;
            this.tag = tag;
            this.zipUrl = zipUrl;
            this.sha256Url = sha256Url;
            this.notes = notes;
            this.zipSize = zipSize;
        }
    }

    private static final String TAG_PREFIX = "web-v";
    private static final String VERSION_FILE = "web-version.txt";
    private static final String WEB_DIR = "web";
    private static final String STAGING_DIR = "web-staging";
    private static final String STAGING_ZIP = "web-staging.zip";
    private static final long MAX_ZIP = 64L * 1024L * 1024L;
    private static final long MAX_FILE = 32L * 1024L * 1024L;
    private static final long MAX_TOTAL = 96L * 1024L * 1024L;
    private static final long MAX_CHECK_RESPONSE = 4L * 1024L * 1024L;
    private static final int MAX_NOTES_CHARS = 600;

    private final File baseDir;
    private final String repo;
    private final String shellVersion;
    private final File webDir;

    /**
     * @param baseDir App 的 files 目录（更新解压到这里）
     * @param repo    GitHub 仓库，形如 owner/name
     * @param shellVersion 当前 APK 壳版本；从没热更新过时，网页层版本默认等于它
     */
    public WebUpdater(File baseDir, String repo, String shellVersion) {
        this.baseDir = baseDir;
        this.repo = repo == null || !repo.contains("/") ? null : repo;
        this.shellVersion = shellVersion == null ? "0" : shellVersion;
        this.webDir = new File(baseDir, WEB_DIR);
    }

    /** 当前网页层版本：装过热更新就是更新时的版本，否则等于 APK 壳版本。 */
    public String currentWebVersion() {
        File file = new File(baseDir, VERSION_FILE);
        try (InputStream in = new FileInputStream(file)) {
            String value = new String(readCapped(in, 64), StandardCharsets.UTF_8).trim();
            return value.isEmpty() ? shellVersion : value;
        } catch (IOException error) {
            return shellVersion;
        }
    }

    /** 网页层根目录（可能不存在 = 从没热更新过）。 */
    public File webDir() {
        return webDir;
    }

    /**
     * 检查 GitHub Releases 上有没有比当前更新的网页层。
     *
     * @return 有更新时返回详情；没有更新 / 仓库没配置返回 null
     * @throws IOException 网络 / 解析失败（消息面向用户）
     */
    public UpdateInfo check() throws IOException {
        if (repo == null) {
            return null;
        }
        String url = "https://api.github.com/repos/" + repo + "/releases?per_page=10";
        HttpURLConnection connection = open(url, "application/vnd.github+json");
        int status;
        try {
            status = connection.getResponseCode();
            if (status == 403 || status == 429) {
                throw new IOException("GitHub 访问太频繁（被限流），过几分钟再试");
            }
            if (status != 200) {
                throw new IOException("GitHub 返回了 " + status);
            }
            byte[] body = readCapped(connection.getInputStream(), MAX_CHECK_RESPONSE);
            return pickRelease(new String(body, StandardCharsets.UTF_8));
        } finally {
            connection.disconnect();
        }
    }

    /** 从 releases 列表 JSON 里挑出最新的 web-v* 正式版。 */
    private UpdateInfo pickRelease(String json) throws IOException {
        Object root;
        try {
            root = new Json(json).parse();
        } catch (RuntimeException error) {
            throw new IOException("GitHub 响应解析失败");
        }
        if (!(root instanceof List)) {
            return null;
        }
        String current = currentWebVersion();
        for (Object item : (List<?>) root) {
            if (!(item instanceof Map)) {
                continue;
            }
            Map<?, ?> release = (Map<?, ?>) item;
            Object tagObj = release.get("tag_name");
            String tag = tagObj == null ? null : String.valueOf(tagObj);
            if (tag == null || !tag.startsWith(TAG_PREFIX)) {
                continue;
            }
            if (Boolean.TRUE.equals(release.get("draft"))
                    || Boolean.TRUE.equals(release.get("prerelease"))) {
                continue;
            }
            String version = tag.substring(TAG_PREFIX.length()).trim();
            if (version.isEmpty() || !isNewer(version, current)) {
                continue;
            }
            String zipUrl = null;
            String shaUrl = null;
            long zipSize = 0;
            Object assetsObj = release.get("assets");
            if (assetsObj instanceof List) {
                for (Object assetItem : (List<?>) assetsObj) {
                    if (!(assetItem instanceof Map)) {
                        continue;
                    }
                    Map<?, ?> asset = (Map<?, ?>) assetItem;
                    String name = String.valueOf(asset.get("name"));
                    Object downloadObj = asset.get("browser_download_url");
                    String download = downloadObj == null ? null : String.valueOf(downloadObj);
                    if ("web.zip".equals(name)) {
                        zipUrl = download;
                        Object sizeObj = asset.get("size");
                        if (sizeObj instanceof Double) {
                            zipSize = ((Double) sizeObj).longValue();
                        }
                    } else if ("web.zip.sha256".equals(name)) {
                        shaUrl = download;
                    }
                }
            }
            if (zipUrl == null || shaUrl == null) {
                continue; // 这个 Release 的资产不齐，跳过
            }
            Object notesObj = release.get("body");
            String notes = notesObj == null ? "" : String.valueOf(notesObj).trim();
            if (notes.length() > MAX_NOTES_CHARS) {
                notes = notes.substring(0, MAX_NOTES_CHARS) + "…";
            }
            return new UpdateInfo(version, tag, zipUrl, shaUrl, notes, zipSize);
        }
        return null;
    }

    /**
     * 下载并安装一次更新。
     *
     * @return 新版本号（安装成功后写进版本文件）
     * @throws IOException 任何一步失败；失败时内置网页不受影响
     */
    public String install(UpdateInfo info, Progress progress) throws IOException {
        Progress report = progress == null ? text -> { } : progress;
        File zipFile = new File(baseDir, STAGING_ZIP);
        File staging = new File(baseDir, STAGING_DIR);
        deleteRecursive(staging);
        if (zipFile.exists() && !zipFile.delete()) {
            throw new IOException("无法清理上次的更新残留，重启 App 后再试");
        }
        try {
            report.report("正在下载更新包…");
            downloadTo(info.zipUrl, zipFile);

            report.report("正在校验更新包…");
            String expected = fetchText(info.sha256Url, 512).trim().split("\\s+")[0];
            String actual = sha256Hex(zipFile);
            if (!expected.equalsIgnoreCase(actual)) {
                throw new IOException("更新包校验失败（sha256 不一致），已取消");
            }

            report.report("正在解压…");
            unzip(zipFile, staging);
            if (!new File(staging, "index.html").isFile()) {
                throw new IOException("更新包里缺少 index.html，已取消");
            }

            report.report("正在切换到新版本…");
            deleteRecursive(webDir);
            if (!staging.renameTo(webDir)) {
                throw new IOException("切换新版本失败，重启 App 后再试");
            }
            writeVersion(info.version);
            return info.version;
        } finally {
            if (zipFile.exists()) {
                boolean ignored = zipFile.delete();
            }
            deleteRecursive(staging);
        }
    }

    /**
     * 给 LocalServer 的 AssetSource 用：优先读热更新目录里的文件。
     * 路径不合法 / 文件不存在时返回 null（调用方回 APK 内置 assets）。
     */
    public InputStream openUpdated(String path) {
        if (path == null || path.isEmpty() || path.contains("..")) {
            return null;
        }
        try {
            File file = new File(webDir, path);
            String root = webDir.getCanonicalPath() + File.separator;
            if (!file.getCanonicalPath().startsWith(root) || !file.isFile()) {
                return null;
            }
            return new FileInputStream(file);
        } catch (IOException error) {
            return null;
        }
    }

    /** JSON 字符串转义：也直接用在往网页发的 JS 字符串里。 */
    public static String jsonEscape(String value) {
        if (value == null) {
            return "";
        }
        StringBuilder out = new StringBuilder(value.length() + 16);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        out.append(String.format(Locale.US, "\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.toString();
    }

    // ------------------------------------------------------------------
    // 版本比较

    private static int[] parseVersion(String version) {
        String[] parts = version.split("\\.");
        int[] numbers = new int[Math.max(3, parts.length)];
        for (int i = 0; i < parts.length && i < numbers.length; i++) {
            try {
                numbers[i] = Integer.parseInt(parts[i].trim());
            } catch (NumberFormatException error) {
                numbers[i] = 0;
            }
        }
        return numbers;
    }

    private static boolean isNewer(String candidate, String current) {
        int[] a = parseVersion(candidate);
        int[] b = parseVersion(current);
        int length = Math.max(a.length, b.length);
        for (int i = 0; i < length; i++) {
            int x = i < a.length ? a[i] : 0;
            int y = i < b.length ? b[i] : 0;
            if (x != y) {
                return x > y;
            }
        }
        return false;
    }

    // ------------------------------------------------------------------
    // 网络与文件

    private HttpURLConnection open(String url, String accept) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(60_000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("Accept", accept);
        connection.setRequestProperty("User-Agent", "card-tree-mobile/" + shellVersion);
        return connection;
    }

    private void downloadTo(String url, File target) throws IOException {
        HttpURLConnection connection = open(url, "application/octet-stream");
        try {
            int status = connection.getResponseCode();
            if (status != 200) {
                throw new IOException("下载更新包失败（HTTP " + status + "）");
            }
            try (InputStream in = connection.getInputStream();
                    OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[16 * 1024];
                long total = 0;
                int read;
                while ((read = in.read(buffer)) >= 0) {
                    total += read;
                    if (total > MAX_ZIP) {
                        throw new IOException("更新包太大，已取消");
                    }
                    out.write(buffer, 0, read);
                }
            }
        } finally {
            connection.disconnect();
        }
    }

    private String fetchText(String url, long cap) throws IOException {
        HttpURLConnection connection = open(url, "text/plain");
        try {
            int status = connection.getResponseCode();
            if (status != 200) {
                throw new IOException("下载校验文件失败（HTTP " + status + "）");
            }
            return new String(readCapped(connection.getInputStream(), cap), StandardCharsets.UTF_8);
        } finally {
            connection.disconnect();
        }
    }

    private static byte[] readCapped(InputStream in, long cap) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream(8192);
            byte[] chunk = new byte[8192];
            long total = 0;
            int read;
            while ((read = stream.read(chunk)) >= 0) {
                total += read;
                if (total > cap) {
                    throw new IOException("响应超出大小限制");
                }
                buffer.write(chunk, 0, read);
            }
            return buffer.toByteArray();
        }
    }

    private static String sha256Hex(File file) throws IOException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (Exception impossible) {
            throw new IOException("sha256 不可用");
        }
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = in.read(buffer)) >= 0) {
                digest.update(buffer, 0, read);
            }
        }
        StringBuilder hex = new StringBuilder(64);
        for (byte b : digest.digest()) {
            hex.append(Character.forDigit((b >> 4) & 0xF, 16));
            hex.append(Character.forDigit(b & 0xF, 16));
        }
        return hex.toString();
    }

    private static void unzip(File zipFile, File targetDir) throws IOException {
        String root = targetDir.getCanonicalPath() + File.separator;
        long total = 0;
        try (ZipInputStream zip = new ZipInputStream(new FileInputStream(zipFile))) {
            ZipEntry entry;
            byte[] buffer = new byte[16 * 1024];
            while ((entry = zip.getNextEntry()) != null) {
                String name = entry.getName();
                if (name == null || name.isEmpty()) {
                    continue;
                }
                File target = new File(targetDir, name);
                if (!target.getCanonicalPath().startsWith(root)) {
                    throw new IOException("更新包里有非法路径，已取消");
                }
                if (entry.isDirectory()) {
                    if (!target.isDirectory() && !target.mkdirs()) {
                        throw new IOException("无法创建目录：" + target);
                    }
                    zip.closeEntry();
                    continue;
                }
                File parent = target.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                    throw new IOException("无法创建目录：" + parent);
                }
                long entryTotal = 0;
                try (OutputStream out = new FileOutputStream(target)) {
                    int read;
                    while ((read = zip.read(buffer)) >= 0) {
                        entryTotal += read;
                        total += read;
                        if (entryTotal > MAX_FILE || total > MAX_TOTAL) {
                            throw new IOException("更新包解压后超出大小限制，已取消");
                        }
                        out.write(buffer, 0, read);
                    }
                }
                zip.closeEntry();
            }
        }
    }

    private void writeVersion(String version) throws IOException {
        File file = new File(baseDir, VERSION_FILE);
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(version.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void deleteRecursive(File file) {
        if (file == null || !file.exists()) {
            return;
        }
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteRecursive(child);
            }
        }
        boolean ignored = file.delete();
    }

    // ------------------------------------------------------------------
    // 一个够用就好的 JSON 解析器：GitHub Releases 响应足够，别的地方别用

    private static final class Json {
        private final String text;
        private int pos;

        Json(String text) {
            this.text = text;
        }

        Object parse() {
            return value();
        }

        private void skip() {
            while (pos < text.length()) {
                char c = text.charAt(pos);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    pos++;
                } else {
                    break;
                }
            }
        }

        private char current() {
            return text.charAt(pos);
        }

        private Object value() {
            skip();
            if (pos >= text.length()) {
                throw new IllegalArgumentException("JSON 意外结束");
            }
            char c = current();
            if (c == '{') {
                return object();
            }
            if (c == '[') {
                return array();
            }
            if (c == '"') {
                pos++;
                return string();
            }
            if (c == 't') {
                expectWord("true");
                return Boolean.TRUE;
            }
            if (c == 'f') {
                expectWord("false");
                return Boolean.FALSE;
            }
            if (c == 'n') {
                expectWord("null");
                return null;
            }
            return number();
        }

        private void expectWord(String word) {
            if (!text.startsWith(word, pos)) {
                throw new IllegalArgumentException("JSON 关键字不对");
            }
            pos += word.length();
        }

        private Map<String, Object> object() {
            Map<String, Object> map = new HashMap<>();
            pos++; // {
            skip();
            if (pos < text.length() && current() == '}') {
                pos++;
                return map;
            }
            while (true) {
                skip();
                if (pos >= text.length() || current() != '"') {
                    throw new IllegalArgumentException("JSON 对象的键必须是字符串");
                }
                pos++;
                String key = string();
                skip();
                if (pos >= text.length() || current() != ':') {
                    throw new IllegalArgumentException("JSON 缺少冒号");
                }
                pos++;
                map.put(key, value());
                skip();
                if (pos >= text.length()) {
                    throw new IllegalArgumentException("JSON 对象没有结束");
                }
                char c = current();
                if (c == ',') {
                    pos++;
                    continue;
                }
                if (c == '}') {
                    pos++;
                    return map;
                }
                throw new IllegalArgumentException("JSON 对象格式不对");
            }
        }

        private List<Object> array() {
            List<Object> list = new ArrayList<>();
            pos++; // [
            skip();
            if (pos < text.length() && current() == ']') {
                pos++;
                return list;
            }
            while (true) {
                list.add(value());
                skip();
                if (pos >= text.length()) {
                    throw new IllegalArgumentException("JSON 数组没有结束");
                }
                char c = current();
                if (c == ',') {
                    pos++;
                    continue;
                }
                if (c == ']') {
                    pos++;
                    return list;
                }
                throw new IllegalArgumentException("JSON 数组格式不对");
            }
        }

        private String string() {
            StringBuilder out = new StringBuilder();
            while (pos < text.length()) {
                char c = text.charAt(pos++);
                if (c == '"') {
                    return out.toString();
                }
                if (c != '\\') {
                    out.append(c);
                    continue;
                }
                if (pos >= text.length()) {
                    break;
                }
                char escape = text.charAt(pos++);
                switch (escape) {
                    case '"':
                        out.append('"');
                        break;
                    case '\\':
                        out.append('\\');
                        break;
                    case '/':
                        out.append('/');
                        break;
                    case 'b':
                        out.append('\b');
                        break;
                    case 'f':
                        out.append('\f');
                        break;
                    case 'n':
                        out.append('\n');
                        break;
                    case 'r':
                        out.append('\r');
                        break;
                    case 't':
                        out.append('\t');
                        break;
                    case 'u':
                        if (pos + 4 > text.length()) {
                            throw new IllegalArgumentException("JSON unicode 转义不完整");
                        }
                        out.append((char) Integer.parseInt(text.substring(pos, pos + 4), 16));
                        pos += 4;
                        break;
                    default:
                        throw new IllegalArgumentException("JSON 转义不认识");
                }
            }
            throw new IllegalArgumentException("JSON 字符串没有结束");
        }

        private Double number() {
            int start = pos;
            while (pos < text.length()) {
                char c = text.charAt(pos);
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') {
                    pos++;
                } else {
                    break;
                }
            }
            try {
                return Double.parseDouble(text.substring(start, pos));
            } catch (NumberFormatException error) {
                throw new IllegalArgumentException("JSON 数字不认识");
            }
        }
    }
}
