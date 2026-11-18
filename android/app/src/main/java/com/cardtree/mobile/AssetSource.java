package com.cardtree.mobile;

import java.io.InputStream;

/** 静态资源来源：手机上从 APK 的 assets 里读，桌面测试时可以从磁盘读。 */
public interface AssetSource {
    /** 打开资源；不存在时返回 null。 */
    InputStream open(String path);
}
