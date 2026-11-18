package com.cardtree.mobile;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 暴露给网页的 {@code window.CardTreeNative}：负责 API Key 的存取、导出备份、状态栏配色等
 * 浏览器里做不到的事。方法都必须是同步返回的基本类型 / 字符串。
 */
public final class NativeBridge {
    private static final int MAX_AUTO_BACKUPS = 30;
    private static final String AUTO_BACKUP_DIR = "CardTree/backups";

    private final MainActivity activity;
    private final KeyVault vault;
    /** 联网搜索用的第二把 Key（DeepSeek），和对话 Key 分开存 */
    private final KeyVault searchVault;
    /** 网页层热更新 */
    private final WebUpdater updater;
    /** 一次只允许一个更新任务在跑 */
    private final AtomicBoolean installing = new AtomicBoolean(false);

    NativeBridge(MainActivity activity, KeyVault vault, KeyVault searchVault, WebUpdater updater) {
        this.activity = activity;
        this.vault = vault;
        this.searchVault = searchVault;
        this.updater = updater;
    }

    @JavascriptInterface
    public boolean hasKey() {
        return vault.hasKey();
    }

    @JavascriptInterface
    public boolean saveKey(String key) {
        boolean saved = vault.save(key);
        if (saved) {
            activity.reloadModelsLater();
        }
        return saved;
    }

    @JavascriptInterface
    public void clearKey() {
        vault.clear();
    }

    @JavascriptInterface
    public boolean hasSearchKey() {
        return searchVault.hasKey();
    }

    @JavascriptInterface
    public boolean saveSearchKey(String key) {
        return searchVault.save(key);
    }

    @JavascriptInterface
    public void clearSearchKey() {
        searchVault.clear();
    }

    @JavascriptInterface
    public String version() {
        return MainActivity.APP_VERSION;
    }

    @JavascriptInterface
    public void setChrome(String background, boolean dark) {
        activity.applyChromeColor(background, dark);
    }

    @JavascriptInterface
    public String saveBackup(String json, String name) {
        return activity.saveBackup(json, name);
    }

    /**
     * 自动备份：把整库 JSON 写进「下载/CardTree/backups」，滚动保留最近 30 份。
     * 返回相对路径供网页 toast 展示；空内容或任何写入失败返回 null。
     */
    @JavascriptInterface
    public String saveAutoBackup(String json) {
        if (json == null || json.isEmpty()) {
            return null;
        }
        String fileName = "backup-"
                + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date())
                + ".json";
        byte[] data = json.getBytes(StandardCharsets.UTF_8);
        try {
            return Build.VERSION.SDK_INT >= 29
                    ? saveAutoBackupMediaStore(fileName, data)
                    : saveAutoBackupLegacy(fileName, data);
        } catch (Exception error) {
            return null;
        }
    }

    /** Android 10+：走 MediaStore.Downloads，IS_PENDING 从 1 收尾到 0。 */
    private String saveAutoBackupMediaStore(String fileName, byte[] data) throws IOException {
        ContentResolver resolver = activity.getContentResolver();
        String relDir = Environment.DIRECTORY_DOWNLOADS + "/" + AUTO_BACKUP_DIR;
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, relDir);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            return null;
        }
        boolean ok = false;
        try {
            try (OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) {
                    return null;
                }
                out.write(data);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(uri, done, null, null);
            ok = true;
        } finally {
            if (!ok) {
                resolver.delete(uri, null, null);
            }
        }
        trimMediaStoreBackups(resolver, relDir);
        return AUTO_BACKUP_DIR + "/" + fileName;
    }

    /** MediaStore 版滚动：按文件名（即时间）倒序，删掉第 31 份及以后。 */
    private void trimMediaStoreBackups(ContentResolver resolver, String relDir) {
        String selection = MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ? AND "
                + MediaStore.MediaColumns.DISPLAY_NAME + " LIKE ?";
        String[] args = new String[]{relDir + "%", "backup-%.json"};
        String sort = MediaStore.MediaColumns.DISPLAY_NAME + " DESC";
        try (Cursor cursor = resolver.query(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                new String[]{MediaStore.MediaColumns._ID},
                selection, args, sort)) {
            if (cursor == null) {
                return;
            }
            int index = 0;
            while (cursor.moveToNext()) {
                if (index >= MAX_AUTO_BACKUPS) {
                    long id = cursor.getLong(
                            cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID));
                    resolver.delete(ContentUris.withAppendedId(
                            MediaStore.Downloads.EXTERNAL_CONTENT_URI, id), null, null);
                }
                index++;
            }
        }
    }

    /** Android 9 及以下：写 app 私有 Documents/CardTree/backups 目录。 */
    private String saveAutoBackupLegacy(String fileName, byte[] data) throws IOException {
        File base = activity.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
        if (base == null) {
            return null;
        }
        File dir = new File(base, AUTO_BACKUP_DIR);
        if (!dir.exists() && !dir.mkdirs()) {
            return null;
        }
        File target = new File(dir, fileName);
        try (FileOutputStream out = new FileOutputStream(target)) {
            out.write(data);
        }
        trimLegacyBackups(dir);
        return AUTO_BACKUP_DIR + "/" + fileName;
    }

    /** File 版滚动：listFiles 后按文件名升序，删掉最旧的多余文件。 */
    private void trimLegacyBackups(File dir) {
        File[] files = dir.listFiles((d, name) ->
                name.startsWith("backup-") && name.endsWith(".json"));
        if (files == null || files.length <= MAX_AUTO_BACKUPS) {
            return;
        }
        Arrays.sort(files, (a, b) -> a.getName().compareTo(b.getName()));
        for (int i = 0; i < files.length - MAX_AUTO_BACKUPS; i++) {
            //noinspection ResultOfMethodCallIgnored
            files[i].delete();
        }
    }

    @JavascriptInterface
    public void toast(String text) {
        activity.showToast(text);
    }

    // ------------------------------------------------------------------
    // 网页层热更新

    /** 当前网页层版本：装过热更新就是更新时的版本，否则等于 APK 壳版本。 */
    @JavascriptInterface
    public String getWebVersion() {
        return updater.currentWebVersion();
    }

    /**
     * 检查更新（同步返回 JSON 字符串）：
     * {@code {"available":true,"version":"0.3.5","size":123,"notes":"…"}}
     * 或 {@code {"available":false}} / {@code {"available":false,"error":"…"}}。
     */
    @JavascriptInterface
    public String checkWebUpdate() {
        try {
            WebUpdater.UpdateInfo info = updater.check();
            if (info == null) {
                return "{\"available\":false}";
            }
            return "{\"available\":true,\"version\":\"" + WebUpdater.jsonEscape(info.version)
                    + "\",\"size\":" + info.zipSize
                    + ",\"notes\":\"" + WebUpdater.jsonEscape(info.notes) + "\"}";
        } catch (Exception error) {
            return "{\"available\":false,\"error\":\"" + WebUpdater.jsonEscape(safeMessage(error))
                    + "\"}";
        }
    }

    /**
     * 开始安装：后台线程里重新检查一次并下载安装，进度经
     * {@code window.__cardTreeUpdateProgress(text)} 回调，结束经
     * {@code window.__cardTreeUpdateDone(ok, message)} 回调（ok 时 message 是新版本号，
     * 网页自己刷新）。已经在装时返回 false。
     */
    @JavascriptInterface
    public boolean installWebUpdate() {
        if (!installing.compareAndSet(false, true)) {
            return false;
        }
        Thread worker = new Thread(() -> {
            try {
                WebUpdater.UpdateInfo info = updater.check();
                if (info == null) {
                    fireUpdateDone(false, "没有需要安装的更新");
                    return;
                }
                String version = updater.install(info, text ->
                        activity.evaluateOnWeb("window.__cardTreeUpdateProgress"
                                + " && window.__cardTreeUpdateProgress(" + quote(text) + ")"));
                fireUpdateDone(true, version);
            } catch (Exception error) {
                fireUpdateDone(false, safeMessage(error));
            } finally {
                installing.set(false);
            }
        }, "card-tree-update");
        worker.setDaemon(true);
        worker.start();
        return true;
    }

    private void fireUpdateDone(boolean ok, String message) {
        activity.evaluateOnWeb("window.__cardTreeUpdateDone && window.__cardTreeUpdateDone("
                + ok + ", " + quote(message) + ")");
    }

    private static String quote(String value) {
        return "\"" + WebUpdater.jsonEscape(value) + "\"";
    }

    private static String safeMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? "更新失败，请稍后再试" : message;
    }
}
