package com.cardtree.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * API Key 的本地保存：用 Android Keystore 里的 AES-256-GCM 密钥加密，密文（iv + ciphertext）
 * 以 Base64 存在 SharedPreferences。密钥本身留在 Keystore，不会被读出来，也不会随备份导出。
 *
 * <p>一个实例只管一个 Key：默认构造（{@link #KeyVault(Context)}）是对话用的
 * opencode go Key；联网搜索用的 DeepSeek Key 用 {@link #KeyVault(Context, String, String)}
 * 另开一个实例，存在不同的 SharedPreferences 字段、用不同的 Keystore 别名。
 */
public final class KeyVault {
    private static final int IV_LENGTH = 12;
    private static final int TAG_BITS = 128;

    private final SharedPreferences prefs;
    private final String field;
    private final String alias;

    /** 对话用的 opencode go Key */
    public KeyVault(Context context) {
        this(context, "api_key", "card_tree_api_key_v1");
    }

    public KeyVault(Context context, String field, String alias) {
        this.prefs = context.getSharedPreferences("card_tree_mobile", Context.MODE_PRIVATE);
        this.field = field;
        this.alias = alias;
    }

    public boolean hasKey() {
        return !prefs.getString(field, "").isEmpty();
    }

    /** 返回解密后的 Key；没有配置或解密失败时返回 null。 */
    public String get() {
        String encoded = prefs.getString(field, "");
        if (encoded.isEmpty()) {
            return null;
        }
        try {
            byte[] packed = Base64.decode(encoded, Base64.NO_WRAP);
            if (packed.length <= IV_LENGTH) {
                return null;
            }
            byte[] iv = Arrays.copyOfRange(packed, 0, IV_LENGTH);
            byte[] cipherText = Arrays.copyOfRange(packed, IV_LENGTH, packed.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(TAG_BITS, iv));
            return new String(cipher.doFinal(cipherText), StandardCharsets.UTF_8);
        } catch (Exception error) {
            return null;
        }
    }

    public boolean save(String key) {
        if (key == null) {
            return false;
        }
        String trimmed = key.trim();
        if (trimmed.isEmpty()) {
            return false;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            byte[] cipherText = cipher.doFinal(trimmed.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            byte[] packed = new byte[iv.length + cipherText.length];
            System.arraycopy(iv, 0, packed, 0, iv.length);
            System.arraycopy(cipherText, 0, packed, iv.length, cipherText.length);
            prefs.edit().putString(field, Base64.encodeToString(packed, Base64.NO_WRAP)).apply();
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    public void clear() {
        prefs.edit().remove(field).apply();
    }

    private SecretKey secretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(alias)) {
            return (SecretKey) keyStore.getKey(alias, null);
        }
        KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }
}
