import json, os, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BASE)

FILES = {
    "lib/three.module.js": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "lib/addons/controls/OrbitControls.js": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js",
}

for rel, url in FILES.items():
    dst = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    data = urllib.request.urlopen(url, timeout=60).read()
    with open(dst, "wb") as f:
        f.write(data)
    print(f"{rel:52s} {len(data)/1024:8.1f} KB")
