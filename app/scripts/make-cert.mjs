#!/usr/bin/env node
/**
 * 生成本机自签证书，让手机能把网页「安装成 App」。
 *
 * 为什么需要：浏览器只在「安全上下文」（https 或 localhost）下才允许注册 Service Worker
 * 并提供安装入口；手机通过局域网 IP（http://192.168.x.x）访问时不满足条件。
 * 所以本脚本生成一套本地 CA + 服务器证书：
 *   app/certs/ca.pem      根证书（公钥，手机装一次即可信任；中继会在 /ca.pem 提供下载）
 *   app/certs/ca.crt      同一张根证书的 DER 格式（安卓/iOS 更容易识别）
 *   app/certs/cert.pem    服务器证书（SAN 含 localhost、127.0.0.1 和本机所有局域网 IPv4）
 *   app/certs/key.pem     服务器私钥（只留在本机，绝不上传、不通过中继暴露）
 *   app/certs/ca.key      本地 CA 私钥（留着以后重新签发服务器证书用）
 *
 * 用法：
 *   node scripts/make-cert.mjs            # 生成（已存在则询问式跳过）
 *   node scripts/make-cert.mjs --force    # 覆盖重新生成
 *   node scripts/make-cert.mjs --ip 10.0.0.5,192.168.1.9   # 额外加 SAN IP
 *
 * 依赖：openssl 可执行文件（Git for Windows 自带，一般无需额外安装）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.resolve(__dirname, '..')
const CERT_DIR = path.join(APP_DIR, 'certs')

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const extraIps = []
for (let i = 0; i < argv.length; i++) {
  const item = argv[i]
  if (item === '--ip') {
    extraIps.push(...(argv[i + 1] ?? '').split(','))
  } else if (item.startsWith('--ip=')) {
    extraIps.push(...item.slice('--ip='.length).split(','))
  }
}
const extraIpList = extraIps.map((item) => item.trim()).filter(Boolean)

const findOpenSsl = () => {
  const candidates = []
  if (process.env.OPENSSL) {
    candidates.push(process.env.OPENSSL)
  }
  candidates.push(
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\OpenSSL-Win32\\bin\\openssl.exe',
    path.join(process.env.ProgramFiles ?? '', 'Git\\usr\\bin\\openssl.exe'),
    '/usr/bin/openssl',
    '/usr/local/bin/openssl',
    '/opt/homebrew/bin/openssl',
  )
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate
    }
  }
  const probe = spawnSync('openssl', ['version'], { stdio: 'pipe', encoding: 'utf8' })
  if (probe.status === 0) {
    return 'openssl'
  }
  return null
}

const openssl = findOpenSsl()
if (!openssl) {
  console.error('✗ 找不到 openssl。')
  console.error('  Windows：安装 Git for Windows 即可（自带 openssl），或装 OpenSSL 后把它加进 PATH。')
  console.error('  macOS/Linux：用系统自带的 openssl（brew install openssl 也可以）。')
  process.exit(1)
}

const run = (args, label) => {
  const result = spawnSync(openssl, args, { stdio: 'pipe', encoding: 'utf8' })
  if (result.status !== 0) {
    console.error(`✗ ${label} 失败`)
    const detail = (result.stderr || result.stdout || '').trim()
    if (detail) {
      console.error(detail)
    }
    process.exit(1)
  }
}

const lanIps = () => {
  const list = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal) {
        list.push(entry.address)
      }
    }
  }
  return list
}

const file = (name) => path.join(CERT_DIR, name)

const certExists = () =>
  ['ca.pem', 'ca.key', 'cert.pem', 'key.pem'].every((name) => existsSync(file(name)))

if (!force && certExists()) {
  console.log('证书已经存在，无需重复生成：')
  for (const name of ['ca.pem', 'ca.crt', 'cert.pem', 'key.pem', 'ca.key']) {
    if (existsSync(file(name))) {
      console.log('  ' + file(name))
    }
  }
  console.log('')
  console.log('要覆盖重新生成，加 --force：node scripts/make-cert.mjs --force')
  process.exit(0)
}

mkdirSync(CERT_DIR, { recursive: true })
for (const name of readdirSync(CERT_DIR)) {
  if (name.endsWith('.csr') || name.endsWith('.ext') || name.endsWith('.srl')) {
    rmSync(file(name), { force: true })
  }
}

const ips = [...new Set(['127.0.0.1', ...lanIps(), ...extraIpList])]
const san = ['DNS:localhost', ...ips.map((ip) => `IP:${ip}`)].join(',')

console.log('生成本地 CA 与服务器证书…')
console.log('  openssl : ' + openssl)
console.log('  SAN     : ' + san)

// 1) 本地 CA（手机要信任的就是它；有效期 10 年）
run(
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-sha256',
    '-days',
    '3650',
    '-keyout',
    file('ca.key'),
    '-out',
    file('ca.pem'),
    '-subj',
    '/CN=Card Tree Mobile Local CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  ],
  '生成根证书',
)

// 2) 服务器私钥 + CSR
run(['genrsa', '-out', file('key.pem'), '2048'], '生成服务器私钥')
run(
  ['req', '-new', '-key', file('key.pem'), '-out', file('server.csr'), '-subj', '/CN=Card Tree Mobile Local Relay'],
  '生成服务器 CSR',
)

// 3) 用本地 CA 签发服务器证书（397 天：避开 iOS 对 TLS 证书有效期的上限）
writeFileSync(
  file('server.ext'),
  [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    'subjectAltName=' + san,
    '',
  ].join('\n'),
)
run(
  [
    'x509',
    '-req',
    '-in',
    file('server.csr'),
    '-CA',
    file('ca.pem'),
    '-CAkey',
    file('ca.key'),
    '-CAcreateserial',
    '-out',
    file('cert.pem'),
    '-days',
    '397',
    '-sha256',
    '-extfile',
    file('server.ext'),
  ],
  '签发服务器证书',
)

// 4) 额外导一份 DER 格式的根证书，安卓/iOS 更容易识别
run(['x509', '-in', file('ca.pem'), '-outform', 'der', '-out', file('ca.crt')], '导出 DER 根证书')

// 清理中间文件
for (const name of ['server.csr', 'server.ext', 'ca.srl']) {
  rmSync(file(name), { force: true })
}

console.log('')
console.log('✓ 完成')
console.log('  根证书 : ' + file('ca.pem') + '   （手机装这个）')
console.log('  根证书 : ' + file('ca.crt') + '   （DER 版，同上）')
console.log('  服务器 : ' + file('cert.pem'))
console.log('  私钥   : ' + file('key.pem') + '   （不要外传）')
console.log('')
console.log('下一步：')
console.log('  1. 重启中继：node server.mjs   （检测到证书会自动切成 HTTPS）')
console.log('  2. 手机上打开 https://<电脑局域网IP>:8787/ca.pem 下载根证书并安装信任')
console.log('     Android：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书')
console.log('     iOS：Safari 打开后允许下载 → 设置 → 通用 → VPN 与设备管理 → 安装')
console.log('          再到 设置 → 通用 → 关于本机 → 证书信任设置 → 打开完全信任')
console.log('  3. 回到 https://<电脑局域网IP>:8787，浏览器菜单选「安装应用 / 添加到主屏幕」')
console.log('')
console.log('提示：局域网 IP 变了（换了网络）就重新跑一次 node scripts/make-cert.mjs --force')
