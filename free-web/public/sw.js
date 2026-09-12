const CACHE='framex-free-v3';
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(c=>c.addAll(['./','./manifest.webmanifest','./icon.svg'])));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',event=>{if(event.request.method!=='GET')return;event.respondWith(fetch(event.request,{cache:'no-store'}).then(res=>{const copy=res.clone();if(new URL(event.request.url).origin===location.origin)caches.open(CACHE).then(c=>c.put(event.request,copy));return res;}).catch(()=>caches.match(event.request)));});
