"""把整个项目打包成一个可以直接双击打开的单文件 HTML。

为什么要这么做：浏览器对 file:// 下的 ES module 有跨域限制，
所以要不起个本地服务器，要么把代码全部揉进一个 <script> 里。
这个脚本选择后者。生成物不依赖网络、不依赖服务器。

用法:
    python tools/build_single.py
"""
import io
import os
import re
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MODULES = [
    'js/version.js',
    'js/palette.js',
    'js/field.js',
    'js/circuit.js',
    'js/scene.js',
    'js/viz.js',
    'js/editor2d.js',
    'js/analysis.js',
    'js/slice.js',
    'js/slicepane.js',
    'js/app.js',
]

IMPORT_NS = re.compile(r"import\s+\*\s+as\s+(\w+)\s+from\s+'([^']+)';?\s*", re.S)
IMPORT_NAMED = re.compile(r"import\s+\{([^}]*)\}\s+from\s+'([^']+)';?\s*", re.S)
EXPORT_DECL = re.compile(r"^export\s+(?=(?:class|function|const|let|var)\s)", re.M)
EXPORT_LIST = re.compile(r"export\s*\{([^}]*)\};?\s*", re.S)


def read(rel):
    with io.open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def parse_export_list(body):
    names = []
    for part in body.split(','):
        part = part.strip()
        if not part:
            continue
        if ' as ' in part:
            orig, alias = [p.strip() for p in part.split(' as ')]
            names.append((alias, orig))
        else:
            names.append((part, part))
    return names


def build_three():
    src = read('lib/three.module.js')
    hits = list(re.finditer(r"export\s*\{([^}]*)\};", src, re.S))
    m = hits[-1]
    pairs = parse_export_list(m.group(1))
    ns = ',\n  '.join(f'{alias}: {orig}' if alias != orig else orig for alias, orig in pairs)
    return src[:m.start()] + '\nconst __THREE_NS = {\n  ' + ns + '\n};\n'


def build_orbit():
    src = read('lib/addons/controls/OrbitControls.js')
    src = IMPORT_NS.sub('', src)
    src = IMPORT_NAMED.sub('', src)
    src = re.sub(r"export\s*\{\s*OrbitControls\s*\};?", '', src)
    # 必须包一层 IIFE：OrbitControls 里的模块级常量（如 _ray）会和 three 主文件重名
    return 'const THREE_ADDONS = (() => {\n' + src + '\nreturn { OrbitControls };\n})();\n'


def collect_exports(body):
    """返回 [(alias, local)]"""
    pairs = []
    for m in re.finditer(r"^export\s+(?:class|function|const|let|var)\s+(\w+)", body, re.M):
        pairs.append((m.group(1), m.group(1)))
    for m in EXPORT_LIST.finditer(body):
        pairs.extend(parse_export_list(m.group(1)))
    return pairs


def build_module(rel):
    src = read(rel)
    prologue = []

    def sub_ns(m):
        ns, mod = m.group(1), m.group(2)
        prologue.append(f'const {ns} = __THREE_NS;')
        return ''

    def sub_named(m):
        names, mod = m.group(1), m.group(2)
        clean = ', '.join(n.strip() for n in names.split(',') if n.strip())
        if mod == 'three':
            prologue.append(f'const {{ {clean} }} = __THREE_NS;')
        elif mod.startswith('three/addons'):
            prologue.append(f'const {{ {clean} }} = THREE_ADDONS;')
        else:
            key = os.path.normpath(os.path.join(os.path.dirname(rel), mod)).replace('\\', '/')
            prologue.append(f"const {{ {clean} }} = __MODS['{key}'];")
        return ''

    src = IMPORT_NS.sub(sub_ns, src)
    src = IMPORT_NAMED.sub(sub_named, src)

    pairs = collect_exports(src)
    src = EXPORT_DECL.sub('', src)
    src = EXPORT_LIST.sub('', src)

    exports = ',\n  '.join(f'{alias}: {local}' if alias != local else local for alias, local in pairs)
    return (
        f"/* ===== {rel} ===== */\n"
        "(() => {\n"
        + '\n'.join(prologue) + ('\n' if prologue else '')
        + src + '\n'
        + f"__MODS['{rel}'] = {{\n  {exports}\n}};\n"
        + "})();\n"
    )


def git_hash():
    try:
        out = subprocess.check_output(
            ['git', 'rev-parse', '--short', 'HEAD'],
            cwd=ROOT, stderr=subprocess.DEVNULL)
        return out.decode().strip()
    except Exception:
        return None


def main():
    css = read('css/style.css')
    html = read('index.html')

    bundle = ['const __MODS = {};\n', build_three(), build_orbit()]
    for rel in MODULES:
        bundle.append(build_module(rel))
    bundle_js = '\n'.join(bundle)

    # 把 git 短哈希写进版本号（version.js 里的 BUILD）
    h = git_hash()
    if h:
        bundle_js = bundle_js.replace('const BUILD = null;', f"const BUILD = '{h}';")
        print(f'  版本号带上 git 哈希: {h}')

    # 去掉 importmap 与 module script，改为内联（用 lambda 避免把 JS 里的反斜杠当转义）
    html = re.sub(r'<script type="importmap">.*?</script>\s*', '', html, flags=re.S)
    html = re.sub(r'<link rel="stylesheet" href="\./css/style\.css" />',
                  lambda m: '<style>\n' + css + '\n</style>', html)
    html = re.sub(r'<script type="module" src="\./js/app\.js"></script>',
                  lambda m: '<script>\n' + bundle_js + '\n</script>', html)

    out = os.path.join(ROOT, 'em-field-lab.html')
    with io.open(out, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'写出 {out}  ({os.path.getsize(out) / 1024 / 1024:.2f} MB)')


if __name__ == '__main__':
    main()
