/*
 * 卡片树 Service Worker（无 workbox 依赖）。
 *
 * - install：skipWaiting，安装后立刻进入等待队列
 * - activate：清掉旧版本缓存并 clients.claim()，立即接管已打开的页面
 * - /api/ 与 /sw.js：永远走网络，不读也不写缓存
 * - 导航请求：network-first，离线时回退缓存的页面壳（/、/index.html）
 * - 其它同源 GET 静态资源：cache-first，命中后写入 card-tree-v1
 *
 * 发布不兼容的新版本时，把 CACHE_NAME 里的版本号加一即可让旧缓存被清掉。
 */

const CACHE_NAME = 'card-tree-v1'
const CACHE_PREFIX = 'card-tree-'
const APP_SHELL_URL = '/index.html'

/** 网络优先：页面导航，失败回退缓存的页面壳 */
const fetchNavigation = async (request) => {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME)
      await cache.put(request, response.clone())
    }
    return response
  } catch (error) {
    const cache = await caches.open(CACHE_NAME)
    const cached =
      (await cache.match(request)) || (await cache.match('/')) || (await cache.match(APP_SHELL_URL))
    if (cached) {
      return cached
    }
    return new Response('离线状态，且没有缓存的页面。', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
}

/** 缓存优先：同源静态资源，命中直接返回，未命中则请求并写入缓存 */
const fetchStatic = async (request) => {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)
  if (cached) {
    return cached
  }
  const response = await fetch(request)
  if (response.ok && response.type === 'basic') {
    try {
      await cache.put(request, response.clone())
    } catch (error) {
      // 缓存写失败（例如配额不足）不影响本次响应
    }
  }
  return response
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys()
      await Promise.all(
        cacheNames
          .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
      await self.clients.claim()
    })()
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') {
    return
  }

  const url = new URL(request.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return
  }
  if (url.origin !== self.location.origin) {
    return
  }
  // 接口与 Service Worker 脚本本身一律不缓存
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') {
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(fetchNavigation(request))
    return
  }
  event.respondWith(fetchStatic(request))
})
