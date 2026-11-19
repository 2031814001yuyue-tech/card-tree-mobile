package com.cardtree.mobile;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * App 内置的本地 HTTP 服务：只监听 127.0.0.1 的随机端口。
 *
 * <p>它做两件事：
 * <ol>
 *   <li>把打包进 APK 的网页（assets/www）当作站点根目录发出去；</li>
 *   <li>把同源的 {@code /api/*} 请求转给四家订阅上游（opencode go / 智谱 Coding /
 *       Kimi Coding / DeepSeek 官方；浏览器直连会被 CORS 预检挡住，所以聊天接口必须走
 *       这一层），并把 SSE 响应逐块透传回 WebView。网页用 x-card-tree-provider 请求头选
 *       上游，缺头按 opencode 处理。</li>
 * </ol>
 *
 * <p>纯 JDK 实现，不依赖 Android 类，便于在桌面 JVM 上单独跑测试。
 */
public final class LocalServer implements Closeable {

    /** 提供 API Key（手机上是 KeyVault 解密后的值）。 */
    public interface KeyProvider {
        String get();
    }

    /** 浏览器侧用来选订阅上游的请求头（值：opencode / zai / kimi / deepseek）。 */
    public static final String PROVIDER_HEADER = "x-card-tree-provider";

    /** opencode go 的上游（四家里默认的那一家，health 里也用它）。 */
    public static final String UPSTREAM = "https://opencode.ai/zen/go/v1";

    /** 联网搜索走 DeepSeek 官方 Search API（和对话模型的上游不是同一家） */
    public static final String SEARCH_UPSTREAM = "https://api.deepseek.com/v1/tools/search";
    public static final String ANTHROPIC_UPSTREAM = "https://api.deepseek.com/anthropic/v1/messages";

    /** 四家订阅上游：都是 OpenAI 兼容协议，差异只在 base 和要不要会话头。 */
    private static final Provider[] PROVIDERS = {
        new Provider("opencode", "opencode go", UPSTREAM, true),
        new Provider("zai", "智谱 Coding", "https://open.bigmodel.cn/api/coding/paas/v4", false),
        new Provider("kimi", "Kimi Coding", "https://api.kimi.com/coding/v1", false),
        new Provider("deepseek", "DeepSeek 官方", "https://api.deepseek.com", false),
    };

    /** 纯数据：一家订阅上游的描述。 */
    private static final class Provider {
        final String id;
        /** 中文显示名，用在「还没配置 Key」的报错里 */
        final String label;
        final String base;
        /** opencode 要额外的 x-opencode-session 头和自定义 User-Agent，其余三家 Bearer 就够 */
        final boolean sessionNeeded;

        Provider(String id, String label, String base, boolean sessionNeeded) {
            this.id = id;
            this.label = label;
            this.base = base;
            this.sessionNeeded = sessionNeeded;
        }
    }

    private static final long MODELS_TTL_MS = 5L * 60L * 1000L;
    private static final int MAX_BODY = 8 * 1024 * 1024;
    private static final int MAX_ASSET = 32 * 1024 * 1024;

    private final ServerSocket socket;
    private final AssetSource assets;
    /** 四家订阅各自的对话 Key（id → 提供者）；没配的 id 不在 Map 里或 get() 为 null */
    private final Map<String, KeyProvider> chatKeys;
    /** 联网搜索用的 DeepSeek Key（没配时整个对象为 null） */
    private final KeyProvider searchKeys;
    private final String sessionId;
    private final String version;
    private final ExecutorService pool;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    /** models 缓存按 provider 分开：id → {body, at}，一家一份互不顶掉 */
    private final Map<String, ModelsCache> modelsCache = new ConcurrentHashMap<>();

    private static final class ModelsCache {
        final String body;
        final long at;

        ModelsCache(String body, long at) {
            this.body = body;
            this.at = at;
        }
    }

    /** 兼容旧调用：只有 opencode 一把 Key，端口交给系统随机分配（桌面 JVM 冒烟测试仍走这里）。 */
    public LocalServer(AssetSource assets, KeyProvider keys, String sessionId, String version)
            throws IOException {
        this(assets, singleProvider(keys), null, sessionId, version, 0);
    }

    /**
     * @param preferredPort 期望固定的端口；> 0 时优先绑定，被占用 / 失败则回退到随机端口。
     */
    public LocalServer(AssetSource assets, KeyProvider keys, String sessionId, String version,
            int preferredPort) throws IOException {
        this(assets, singleProvider(keys), null, sessionId, version, preferredPort);
    }

    /**
     * @param chatKeys 四家订阅各自的对话 Key（id → KeyProvider）；没配的 id 可以不在 Map 里。
     *        旧网页层不带 x-card-tree-provider 头，缺头按 opencode 处理。
     * @param searchKeys 联网搜索用的 DeepSeek Key 提供者；null 表示没配，搜索接口会返回 409。
     */
    public LocalServer(AssetSource assets, Map<String, KeyProvider> chatKeys,
            KeyProvider searchKeys, String sessionId, String version, int preferredPort)
            throws IOException {
        this.assets = assets;
        this.chatKeys = chatKeys == null ? new HashMap<>() : chatKeys;
        this.searchKeys = searchKeys;
        this.sessionId = sessionId;
        this.version = version;
        this.socket = bind(preferredPort);
        this.pool = Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "card-tree-http");
            thread.setDaemon(true);
            return thread;
        });
        Thread accept = new Thread(this::acceptLoop, "card-tree-accept");
        accept.setDaemon(true);
        accept.start();
    }

    /** 只监听 127.0.0.1；固定端口失败时静默回退到 0（随机），保证服务总能起来。 */
    private static ServerSocket bind(int preferredPort) throws IOException {
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        if (preferredPort > 0) {
            try {
                return new ServerSocket(preferredPort, 50, loopback);
            } catch (IOException | IllegalArgumentException preferredFailed) {
                // 固定端口被占用或不可用：换随机端口，避免整个 App 起不来
            }
        }
        return new ServerSocket(0, 50, loopback);
    }

    public int port() {
        return socket.getLocalPort();
    }

    @Override
    public void close() {
        closed.set(true);
        try {
            socket.close();
        } catch (IOException ignored) {
            // 关闭时忽略
        }
        pool.shutdownNow();
    }

    private void acceptLoop() {
        while (!closed.get()) {
            try {
                Socket client = socket.accept();
                pool.execute(() -> handle(client));
            } catch (IOException error) {
                if (closed.get()) {
                    return;
                }
            }
        }
    }

    private void handle(Socket client) {
        try (Socket socket = client) {
            socket.setSoTimeout(30_000);
            socket.setTcpNoDelay(true);
            InputStream in = new BufferedInputStream(socket.getInputStream(), 8192);
            OutputStream out = socket.getOutputStream();

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) {
                return;
            }
            String[] parts = requestLine.split(" ");
            if (parts.length < 3) {
                sendText(out, 400, "Bad Request");
                return;
            }
            String method = parts[0].toUpperCase(Locale.ROOT);
            String path = parts[1];
            int query = path.indexOf('?');
            if (query >= 0) {
                path = path.substring(0, query);
            }

            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    headers.put(
                            line.substring(0, colon).trim().toLowerCase(Locale.ROOT),
                            line.substring(colon + 1).trim());
                }
            }

            byte[] body = null;
            String contentLength = headers.get("content-length");
            if (contentLength != null && !contentLength.isEmpty()) {
                int length;
                try {
                    length = Integer.parseInt(contentLength);
                } catch (NumberFormatException error) {
                    length = 0;
                }
                if (length > MAX_BODY) {
                    sendText(out, 413, "Payload Too Large");
                    return;
                }
                body = readFully(in, length);
            }

            if ("/api/health".equals(path)) {
                sendJson(out, 200, health());
                return;
            }
            if ("/api/models".equals(path)) {
                handleModels(out, headers);
                return;
            }
            if ("/api/chat/completions".equals(path)) {
                if (!"POST".equals(method)) {
                    sendText(out, 405, "Method Not Allowed");
                    return;
                }
                handleChat(out, headers, body);
                return;
            }
            if ("/api/deepseek/search".equals(path)) {
                if (!"POST".equals(method)) {
                    sendText(out, 405, "Method Not Allowed");
                    return;
                }
                handleSearch(out, body);
                return;
            }
            if ("/api/deepseek/messages".equals(path)) {
                if (!"POST".equals(method)) {
                    sendText(out, 405, "Method Not Allowed");
                    return;
                }
                handleAnthropic(out, body);
                return;
            }
            if (path.startsWith("/api/")) {
                sendJson(out, 404, "{\"error\":\"not_found\"}");
                return;
            }
            if (!"GET".equals(method) && !"HEAD".equals(method)) {
                sendText(out, 405, "Method Not Allowed");
                return;
            }
            serveAsset(out, path, "HEAD".equals(method));
        } catch (IOException ignored) {
            // 客户端提前断开（下拉刷新、切页、停止生成）都会走到这里，属于正常情况
        }
    }

    private String health() {
        String key = keyOf("opencode");
        boolean hasKey = key != null && !key.isEmpty();
        String searchKey = searchKeys == null ? null : searchKeys.get();
        boolean hasSearchKey = searchKey != null && !searchKey.isEmpty();
        return "{\"ok\":true,\"mode\":\"android\",\"upstream\":\"" + UPSTREAM
                + "\",\"hasKey\":" + hasKey
                + ",\"search\":" + hasSearchKey
                + ",\"searchUpstream\":\"" + SEARCH_UPSTREAM
                + "\",\"providers\":" + providersJson()
                + ",\"version\":\"" + version + "\"}";
    }

    /** health 里的 providers 段：每家订阅上游有没有配好 Key。 */
    private String providersJson() {
        StringBuilder json = new StringBuilder("{");
        for (int i = 0; i < PROVIDERS.length; i++) {
            if (i > 0) {
                json.append(',');
            }
            String key = keyOf(PROVIDERS[i].id);
            json.append('\"').append(PROVIDERS[i].id).append("\":")
                    .append(key != null && !key.isEmpty());
        }
        return json.append('}').toString();
    }

    /** 某家订阅的对话 Key；没这家或没配都返回 null。 */
    private String keyOf(String id) {
        KeyProvider provider = chatKeys.get(id);
        return provider == null ? null : provider.get();
    }

    /**
     * 联网搜索转发：把网页发来的 {@code {query,count,ori_question}} 原样转给 DeepSeek Search API，
     * 响应也原样透传（网页端两种返回结构都认：中继的 {@code sources} 和 DeepSeek 的 {@code results}）。
     */
    private void handleSearch(OutputStream out, byte[] body) throws IOException {
        String key = searchKeys == null ? null : searchKeys.get();
        if (key == null || key.isEmpty()) {
            sendJson(out, 409, "{\"error\":{\"code\":\"search_unavailable\","
                    + "\"message\":\"还没有配置 DeepSeek Search API Key，到「设置 → 联网搜索」里粘贴一把就可以了。\"}}");
            return;
        }
        byte[] payload = body == null ? new byte[0] : body;
        HttpURLConnection connection =
                (HttpURLConnection) new URL(SEARCH_UPSTREAM).openConnection();
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(20_000);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("Authorization", "Bearer " + key);
        connection.setRequestProperty("User-Agent", "card-tree-mobile/" + version + " (android)");
        try (OutputStream upstreamOut = connection.getOutputStream()) {
            upstreamOut.write(payload);
            upstreamOut.flush();
        }
        int status = connection.getResponseCode();
        byte[] response = readAll(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
        connection.disconnect();
        if (status < 200 || status >= 300) {
            // 上游错误按原文透传，网页端会读出 error.message 提示用户
            sendRaw(out, status, "application/json; charset=utf-8",
                    response == null ? new byte[0] : response);
            return;
        }
        sendRaw(out, 200, "application/json; charset=utf-8",
                response == null ? new byte[0] : response);
    }

    private void handleModels(OutputStream out, Map<String, String> headers) throws IOException {
        String id = providerId(headers);
        Provider provider = findProvider(id);
        if (provider == null) {
            sendJson(out, 400, unknownProviderJson(id));
            return;
        }
        String key = keyOf(id);
        if (key == null || key.isEmpty()) {
            sendJson(out, 409, unavailableProviderJson(provider));
            return;
        }
        ModelsCache cached = modelsCache.get(id);
        if (cached != null && System.currentTimeMillis() - cached.at < MODELS_TTL_MS) {
            sendRaw(out, 200, "application/json; charset=utf-8",
                    cached.body.getBytes(StandardCharsets.UTF_8));
            return;
        }
        HttpURLConnection connection = open(provider.base + "/models", "GET", key, provider);
        try {
            int status = connection.getResponseCode();
            byte[] payload = readAll(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
            if (status == 200) {
                modelsCache.put(id, new ModelsCache(
                        new String(payload, StandardCharsets.UTF_8), System.currentTimeMillis()));
            }
            sendRaw(out, status, "application/json; charset=utf-8", payload);
        } finally {
            connection.disconnect();
        }
    }

    private void handleChat(OutputStream out, Map<String, String> headers, byte[] body)
            throws IOException {
        String id = providerId(headers);
        Provider provider = findProvider(id);
        if (provider == null) {
            sendJson(out, 400, unknownProviderJson(id));
            return;
        }
        String key = keyOf(id);
        if (key == null || key.isEmpty()) {
            sendJson(out, 409, unavailableProviderJson(provider));
            return;
        }
        byte[] payload = body == null ? new byte[0] : body;
        HttpURLConnection connection =
                (HttpURLConnection) new URL(provider.base + "/chat/completions").openConnection();
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(600_000);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Accept", "text/event-stream");
        connection.setRequestProperty("Accept-Encoding", "identity");
        applyAuth(connection, provider, key);
        try (OutputStream upstreamOut = connection.getOutputStream()) {
            upstreamOut.write(payload);
            upstreamOut.flush();
        }
        int status = connection.getResponseCode();
        String contentType = connection.getContentType();
        if (status < 200 || status >= 300) {
            byte[] error = readAll(connection.getErrorStream());
            sendRaw(out, status,
                    contentType == null ? "application/json; charset=utf-8" : contentType, error);
            connection.disconnect();
            return;
        }
        String head = "HTTP/1.1 200 OK\r\n"
                + "Content-Type: " + (contentType == null || contentType.isEmpty()
                        ? "text/event-stream; charset=utf-8" : contentType) + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n"
                + "X-Accel-Buffering: no\r\n"
                + "\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.flush();
        InputStream upstream = connection.getInputStream();
        byte[] buffer = new byte[4096];
        try {
            int read;
            while (!closed.get() && (read = upstream.read(buffer)) >= 0) {
                out.write(buffer, 0, read);
                out.flush();
            }
        } catch (IOException ignored) {
            // WebView 主动取消（点停止）时会断开连接
        } finally {
            connection.disconnect();
        }
    }

    // ------------------------------------------------------------------
    // 订阅路由

    /**
     * 原生联网搜索转发：把网页发来的 Anthropic 协议请求体原样转给 DeepSeek 官方
     * {@code /anthropic/v1/messages}（SSE 逐块透传）。Key 与联网搜索共用 DeepSeek 那把。
     */
    private void handleAnthropic(OutputStream out, byte[] body) throws IOException {
        String key = searchKeys == null ? null : searchKeys.get();
        if (key == null || key.isEmpty()) {
            sendJson(out, 409, "{\"error\":{\"code\":\"search_unavailable\","
                    + "\"message\":\"还没有配置 DeepSeek 官方 API Key，到「设置 → 连接」里切换到 DeepSeek 官方并粘贴一把 Key。\"}}");
            return;
        }
        byte[] payload = body == null ? new byte[0] : body;
        HttpURLConnection connection =
                (HttpURLConnection) new URL(ANTHROPIC_UPSTREAM).openConnection();
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(600_000);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Accept", "text/event-stream");
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("x-api-key", key);
        connection.setRequestProperty("Authorization", "Bearer " + key);
        connection.setRequestProperty("anthropic-version", "2023-06-01");
        connection.setRequestProperty("User-Agent", "card-tree-mobile/" + version + " (android)");
        try (OutputStream upstreamOut = connection.getOutputStream()) {
            upstreamOut.write(payload);
            upstreamOut.flush();
        }
        int status = connection.getResponseCode();
        String contentType = connection.getContentType();
        if (status < 200 || status >= 300) {
            byte[] error = readAll(connection.getErrorStream());
            sendRaw(out, status,
                    contentType == null ? "application/json; charset=utf-8" : contentType, error);
            connection.disconnect();
            return;
        }
        String head = "HTTP/1.1 200 OK\r\n"
                + "Content-Type: " + (contentType == null || contentType.isEmpty()
                        ? "text/event-stream; charset=utf-8" : contentType) + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n"
                + "X-Accel-Buffering: no\r\n"
                + "\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.flush();
        InputStream upstream = connection.getInputStream();
        byte[] buffer = new byte[4096];
        try {
            int read;
            while (!closed.get() && (read = upstream.read(buffer)) >= 0) {
                out.write(buffer, 0, read);
                out.flush();
            }
        } catch (IOException ignored) {
            // WebView 主动取消（点停止）时会断开连接
        } finally {
            connection.disconnect();
        }
    }

    /** 缺头 / 空头都按 opencode 处理，兼容不带头的旧网页层。 */
    private static String providerId(Map<String, String> headers) {
        String value = headers.get(PROVIDER_HEADER);
        if (value == null || value.isEmpty()) {
            return "opencode";
        }
        return value.trim().toLowerCase(Locale.ROOT);
    }

    private static Provider findProvider(String id) {
        for (Provider provider : PROVIDERS) {
            if (provider.id.equals(id)) {
                return provider;
            }
        }
        return null;
    }

    /** 旧构造只有一把 Key：包成 opencode 一家的 Map（HashMap 容忍 null 值，Map.of 会直接炸）。 */
    private static Map<String, KeyProvider> singleProvider(KeyProvider keys) {
        Map<String, KeyProvider> map = new HashMap<>();
        map.put("opencode", keys);
        return map;
    }

    private static String unknownProviderJson(String id) {
        return "{\"error\":{\"code\":\"provider_unknown\",\"message\":\"未知的订阅源「"
                + jsonEscape(id) + "」，可选：opencode / zai / kimi / deepseek。\"}}";
    }

    private static String unavailableProviderJson(Provider provider) {
        return "{\"error\":{\"code\":\"provider_unavailable\",\"message\":\"还没有配置「"
                + provider.label + "」的 API Key，到「设置 → 连接」里粘贴一把。\"}}";
    }

    /** 错误 JSON 里要原样放请求头的内容，先转义掉。 */
    private static String jsonEscape(String value) {
        StringBuilder json = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"':
                    json.append("\\\"");
                    break;
                case '\\':
                    json.append("\\\\");
                    break;
                case '\b':
                    json.append("\\b");
                    break;
                case '\f':
                    json.append("\\f");
                    break;
                case '\n':
                    json.append("\\n");
                    break;
                case '\r':
                    json.append("\\r");
                    break;
                case '\t':
                    json.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        json.append(String.format("\\u%04x", (int) c));
                    } else {
                        json.append(c);
                    }
            }
        }
        return json.toString();
    }

    private HttpURLConnection open(String url, String method, String key, Provider provider)
            throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(60_000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Accept-Encoding", "identity");
        applyAuth(connection, provider, key);
        return connection;
    }

    /** 四家都是 Bearer；会话头和自定义 User-Agent 只有 opencode 需要。 */
    private void applyAuth(HttpURLConnection connection, Provider provider, String key) {
        connection.setRequestProperty("Authorization", "Bearer " + key);
        if (provider.sessionNeeded) {
            connection.setRequestProperty("x-opencode-session", sessionId);
            connection.setRequestProperty("User-Agent", "card-tree-mobile/" + version + " (android)");
        }
    }

    private void serveAsset(OutputStream out, String path, boolean headOnly) throws IOException {
        String name = path.isEmpty() || "/".equals(path) ? "index.html" : path.substring(1);
        if (name.contains("..")) {
            sendText(out, 400, "Bad Request");
            return;
        }
        byte[] payload = readAsset(name);
        boolean fallback = false;
        if (payload == null && !name.contains(".")) {
            payload = readAsset("index.html");
            fallback = true;
        }
        if (payload == null) {
            sendText(out, 404, "Not Found");
            return;
        }
        String type = fallback || name.endsWith(".html")
                ? "text/html; charset=utf-8" : Mime.of(name);
        String head = "HTTP/1.1 200 OK\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + payload.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "X-Content-Type-Options: nosniff\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        if (!headOnly) {
            out.write(payload);
        }
        out.flush();
    }

    private byte[] readAsset(String name) {
        InputStream in = assets.open(name);
        if (in == null) {
            return null;
        }
        try (InputStream stream = in) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream(64 * 1024);
            byte[] chunk = new byte[16 * 1024];
            int total = 0;
            int read;
            while ((read = stream.read(chunk)) >= 0) {
                total += read;
                if (total > MAX_ASSET) {
                    return null;
                }
                buffer.write(chunk, 0, read);
            }
            return buffer.toByteArray();
        } catch (IOException error) {
            return null;
        }
    }

    private void sendJson(OutputStream out, int status, String json) throws IOException {
        sendRaw(out, status, "application/json; charset=utf-8",
                json.getBytes(StandardCharsets.UTF_8));
    }

    private void sendText(OutputStream out, int status, String text) throws IOException {
        sendRaw(out, status, "text/plain; charset=utf-8",
                text.getBytes(StandardCharsets.UTF_8));
    }

    private void sendRaw(OutputStream out, int status, String type, byte[] payload)
            throws IOException {
        byte[] body = payload == null ? new byte[0] : payload;
        String head = "HTTP/1.1 " + status + " " + reason(status) + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static String reason(int status) {
        switch (status) {
            case 200:
                return "OK";
            case 400:
                return "Bad Request";
            case 401:
                return "Unauthorized";
            case 404:
                return "Not Found";
            case 405:
                return "Method Not Allowed";
            case 409:
                return "Conflict";
            case 413:
                return "Payload Too Large";
            default:
                return "OK";
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(128);
        int value = -1;
        while ((value = in.read()) != -1) {
            if (value == '\n') {
                break;
            }
            if (value != '\r') {
                buffer.write(value);
            }
            if (buffer.size() > 8192) {
                break;
            }
        }
        if (value == -1 && buffer.size() == 0) {
            return null;
        }
        return buffer.toString("ISO-8859-1");
    }

    private static byte[] readFully(InputStream in, int length) throws IOException {
        byte[] data = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = in.read(data, offset, length - offset);
            if (read < 0) {
                break;
            }
            offset += read;
        }
        if (offset == length) {
            return data;
        }
        byte[] trimmed = new byte[offset];
        System.arraycopy(data, 0, trimmed, 0, offset);
        return trimmed;
    }

    private static byte[] readAll(InputStream in) throws IOException {
        if (in == null) {
            return new byte[0];
        }
        try (InputStream stream = in) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream(4096);
            byte[] chunk = new byte[4096];
            int read;
            while ((read = stream.read(chunk)) >= 0) {
                buffer.write(chunk, 0, read);
            }
            return buffer.toByteArray();
        }
    }
}
