package com.cardtree.mobile;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 唯一的 Activity：起本地 HTTP 服务、把 WebView 指过去，并把原生能力桥给网页。
 *
 * <p>这样网页是「同源」的，不需要 CORS；API Key 不远走，只在本机加密保存。
 */
public final class MainActivity extends Activity {

    public static final String APP_VERSION = "0.3.12";

    /** 网页层热更新从这个仓库的 GitHub Releases 拿（tag 形如 web-v0.3.5，附带 web.zip + 哈希）。 */
    private static final String UPDATE_REPO = "2031814001yuyue-tech/card-tree-mobile";

    private static final int REQUEST_FILE = 1001;
    private static final String PREFS = "card_tree_mobile";
    private static final String SESSION_FIELD = "session_id";
    private static final String PORT_FIELD = "local_port";
    private static final String MIRROR_FIELD = "update_mirror";

    private WebView web;
    private LocalServer server;
    private KeyVault vault;
    /** 联网搜索用的 DeepSeek Key（和对话 Key 分开存，同时就是 deepseek 订阅那一把） */
    private KeyVault searchVault;
    /** 智谱 Coding 订阅的 Key */
    private KeyVault zaiVault;
    /** Kimi Coding 订阅的 Key */
    private KeyVault kimiVault;
    /** 网页层热更新：检查 / 下载 GitHub Releases 上的新网页包 */
    private WebUpdater updater;
    private ValueCallback<Uri[]> pendingFiles;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        vault = new KeyVault(this);
        searchVault = new KeyVault(this, "deepseek_api_key", "card_tree_deepseek_key_v1");
        zaiVault = new KeyVault(this, "zai_api_key", "card_tree_zai_key_v1");
        kimiVault = new KeyVault(this, "kimi_api_key", "card_tree_kimi_key_v1");
        // 四家订阅各自的 Key（HashMap 而不是 Map.of，免得哪天混进空值直接 NPE）；
        // deepseek 订阅与联网搜索共用同一把 deepseek_api_key
        Map<String, KeyVault> providerVaults = new HashMap<>();
        providerVaults.put("opencode", vault);
        providerVaults.put("zai", zaiVault);
        providerVaults.put("kimi", kimiVault);
        providerVaults.put("deepseek", searchVault);
        updater = new WebUpdater(getFilesDir(), UPDATE_REPO, APP_VERSION);
        // 上次设置的下载镜像（国内直连 GitHub 拉不动时走加速前缀）
        updater.setMirror(getSharedPreferences(PREFS, MODE_PRIVATE).getString(MIRROR_FIELD, ""));
        web = new WebView(this);
        web.setBackgroundColor(getResources().getColor(R.color.paper, getTheme()));
        configure(web, providerVaults);
        setContentView(web);
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        int preferredPort = prefs.getInt(PORT_FIELD, 0);
        try {
            AssetSource assets = path -> {
                // 热更新过的网页层优先：先读 files/web/，读不到再回 APK 内置的 assets/www
                InputStream updated = updater.openUpdated(path);
                if (updated != null) {
                    return updated;
                }
                try {
                    return getAssets().open("www/" + path);
                } catch (IOException error) {
                    return null;
                }
            };
            server = new LocalServer(assets, chatKeys(providerVaults), searchVault::get,
                    sessionId(), APP_VERSION, preferredPort);
            // 启动成功后把实际端口写回：首次随机，之后固定，WebView 的源不会变
            prefs.edit().putInt(PORT_FIELD, server.port()).apply();
            // 回答完成通知：SSE 自然读尽时本地服务回调；只有 App 在后台才发（前台用户看得见，别打扰）
            server.setChatDoneListener(this::notifyAnswerDone);
            web.loadUrl("http://127.0.0.1:" + server.port() + "/");
            // 稳定起来之后静默查一次网页层更新（失败不打扰用户）
            web.postDelayed(this::checkWebUpdateSilently, 4000);
        } catch (IOException error) {
            showToast("本地服务启动失败：" + error.getMessage());
            finish();
        }
        requestNotificationPermissionIfNeeded();
    }

    /** App 在前台时用户本来就看得见，不打扰；退到后台才需要通知。 */
    private volatile boolean resumed = true;

    @Override
    protected void onResume() {
        super.onResume();
        resumed = true;
    }

    @Override
    protected void onPause() {
        super.onPause();
        resumed = false;
    }

    private void requestNotificationPermissionIfNeeded() {
        // Android 13+ 发通知要运行时授权；拒绝过就静默不发，不影响其它功能
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                        != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1002);
        }
    }

    /** 本地服务回调：一条对话（或原生搜索）正常生成完了。providerId 备用（标题里可以区分订阅）。 */
    private void notifyAnswerDone(String providerId) {
        if (resumed) {
            return;
        }
        runOnUiThread(() -> {
            try {
                android.app.NotificationManager manager =
                        (android.app.NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                android.app.NotificationChannel channel = new android.app.NotificationChannel(
                        "answers", "回答完成", android.app.NotificationManager.IMPORTANCE_DEFAULT);
                channel.setDescription("App 在后台时提醒回答已经生成完");
                manager.createNotificationChannel(channel);
                Intent intent = new Intent(this, MainActivity.class);
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                android.app.PendingIntent pending = android.app.PendingIntent.getActivity(
                        this, 0, intent, android.app.PendingIntent.FLAG_IMMUTABLE);
                android.app.Notification notification =
                        new android.app.Notification.Builder(this, "answers")
                                .setSmallIcon(R.mipmap.ic_launcher)
                                .setContentTitle("卡片树 · 回答完成")
                                .setContentText("有一条卡片刚刚回答完，回来看看吧")
                                .setContentIntent(pending)
                                .setAutoCancel(true)
                                .build();
                manager.notify(1001, notification);
            } catch (RuntimeException ignored) {
                // SecurityException 是 RuntimeException 的子类；没授权 / 系统限制：静默跳过，不影响回答本身
            }
        });
    }

    private void configure(WebView view, Map<String, KeyVault> providerVaults) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setUserAgentString(settings.getUserAgentString() + " CardTree/" + APP_VERSION);
        view.addJavascriptInterface(
                new NativeBridge(this, vault, providerVaults, updater), "CardTreeNative");
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView web, WebResourceRequest request) {
                return openExternal(request.getUrl().toString());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView web, String url) {
                return openExternal(url);
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView web, ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                pendingFiles = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择文件"), REQUEST_FILE);
                } catch (Exception error) {
                    pendingFiles = null;
                    return false;
                }
                return true;
            }
        });
    }

    /** LocalServer 要的是「id → 取 Key 的函数」：把四把 vault 换成四个 KeyProvider。 */
    private static Map<String, LocalServer.KeyProvider> chatKeys(
            Map<String, KeyVault> providerVaults) {
        Map<String, LocalServer.KeyProvider> chatKeys = new HashMap<>();
        for (Map.Entry<String, KeyVault> entry : providerVaults.entrySet()) {
            KeyVault value = entry.getValue();
            if (value != null) {
                chatKeys.put(entry.getKey(), value::get);
            }
        }
        return chatKeys;
    }

    private boolean openExternal(String url) {
        if (url.startsWith("http://127.0.0.1:") || url.startsWith("https://127.0.0.1:")) {
            return false;
        }
        if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("mailto:")) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception ignored) {
            // 没有能打开的 App 就留在原地
        }
        return true;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
            if (pendingFiles != null) {
                pendingFiles.onReceiveValue(result);
                pendingFiles = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript(
                "(function(){try{return (window.__cardTreeBack && window.__cardTreeBack()) ? 'true' : 'false';}"
                        + "catch(e){return 'false';}})()",
                value -> {
                    if (!"true".equals(value) && !"\"true\"".equals(value)) {
                        finish();
                    }
                });
    }

    @Override
    protected void onDestroy() {
        if (server != null) {
            server.close();
            server = null;
        }
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    void reloadModelsLater() {
        if (web == null) {
            return;
        }
        web.postDelayed(() -> web.evaluateJavascript(
                "(window.__cardTreeKeyChanged && window.__cardTreeKeyChanged())", null), 400);
    }

    /** 给 NativeBridge 用：在 UI 线程里执行网页侧的 JS（进度 / 完成回调）。 */
    void evaluateOnWeb(String script) {
        runOnUiThread(() -> {
            if (web != null) {
                web.evaluateJavascript(script, null);
            }
        });
    }

    /** 启动后的静默检查：有新网页层就 toast 一下，让用户去 设置 → 关于 更新。 */
    private void checkWebUpdateSilently() {
        final WebUpdater current = updater;
        if (current == null || web == null) {
            return;
        }
        Thread check = new Thread(() -> {
            try {
                WebUpdater.UpdateInfo info = current.check();
                if (info != null) {
                    showToast("网页层有新版 " + info.version + "，到 设置 → 关于 更新");
                }
            } catch (IOException ignored) {
                // 静默检查失败不打扰用户
            }
        }, "card-tree-update-check");
        check.setDaemon(true);
        check.start();
    }

    /** 给 NativeBridge 用：记住热更新下载镜像前缀（空 = 直连）。 */
    void saveUpdateMirror(String prefix) {
        getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit()
                .putString(MIRROR_FIELD, prefix == null ? "" : prefix)
                .apply();
    }

    void showToast(String text) {
        runOnUiThread(() -> Toast.makeText(this, text, Toast.LENGTH_SHORT).show());
    }

    /** 让原生状态栏 / 导航栏跟上网页的纸面颜色。 */
    void applyChromeColor(String background, boolean dark) {
        runOnUiThread(() -> {
            int color;
            try {
                color = Color.parseColor(background);
            } catch (IllegalArgumentException error) {
                return;
            }
            getWindow().setStatusBarColor(color);
            getWindow().setNavigationBarColor(color);
            int flags = getWindow().getDecorView().getSystemUiVisibility();
            flags = dark
                    ? (flags & ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR)
                    : (flags | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
            if (Build.VERSION.SDK_INT >= 26) {
                flags = dark
                        ? (flags & ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR)
                        : (flags | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
            }
            getWindow().getDecorView().setSystemUiVisibility(flags);
        });
    }

    /** 把导出的备份写到「下载/CardTree」；返回给网页展示的落点描述。 */
    String saveBackup(String json, String name) {
        if (json == null || json.isEmpty()) {
            return null;
        }
        String safe = name == null || name.isEmpty() ? "card-tree.json" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
        byte[] data = json.getBytes(StandardCharsets.UTF_8);
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                values.put(MediaStore.MediaColumns.MIME_TYPE, "application/json");
                values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/CardTree");
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    return null;
                }
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) {
                        return null;
                    }
                    out.write(data);
                }
                return "下载/CardTree/" + safe;
            }
            File dir = getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
            if (dir == null) {
                return null;
            }
            File target = new File(dir, safe);
            try (FileOutputStream out = new FileOutputStream(target)) {
                out.write(data);
            }
            return target.getAbsolutePath();
        } catch (IOException error) {
            return null;
        }
    }

    private String sessionId() {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String stored = prefs.getString(SESSION_FIELD, "");
        if (stored != null && !stored.isEmpty()) {
            return stored;
        }
        String androidId = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
        String seed = androidId == null || androidId.isEmpty()
                ? "card-tree-" + UUID.randomUUID()
                : "card-tree-" + androidId;
        prefs.edit().putString(SESSION_FIELD, seed).apply();
        return seed;
    }
}
