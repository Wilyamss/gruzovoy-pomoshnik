"""Собирает аватарку и приветственную картинку бота из van.svg.part и рендерит их Chrome'ом.
Запуск:  python3 brand/build.py
"""
import pathlib, subprocess

HERE = pathlib.Path(__file__).resolve().parent
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
van = (HERE / "van.svg.part").read_text(encoding="utf-8")
hexpat = ('<pattern id="hex" width="56" height="97" patternUnits="userSpaceOnUse">'
          '<path d="M28 0l28 16v32L28 64 0 48V16zM28 64v33" fill="none" stroke="#fff" stroke-width="2"/></pattern>')

avatar = f'''<!doctype html><meta charset="utf-8"><style>html,body{{margin:0;background:#252A2D}}svg{{display:block}}</style>
<svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
<defs>{hexpat}
<radialGradient id="glow" cx=".5" cy=".55" r=".5"><stop offset="0" stop-color="#55C8BD" stop-opacity=".18"/><stop offset="1" stop-color="#55C8BD" stop-opacity="0"/></radialGradient>
<linearGradient id="fade" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient>
<mask id="m"><rect width="1024" height="1024" fill="url(#fade)"/></mask></defs>
<rect width="1024" height="1024" fill="#252A2D"/>
<rect width="1024" height="1024" fill="url(#hex)" opacity=".07" mask="url(#m)"/>
<rect width="1024" height="1024" fill="url(#glow)"/>
<polygon points="-60,1024 360,200 500,200 80,1024" fill="#2F3539"/>
<polygon points="600,1024 1020,200 1050,200 630,1024" fill="#2F3539"/>
<g transform="translate(512 520) scale(1.02) translate(-521 -560)">{van}</g>
</svg>'''

banner = f'''<!doctype html><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@700;800&family=Manrope:wght@600;700&display=swap" rel="stylesheet">
<style>html,body{{margin:0;width:1280px;height:720px;overflow:hidden;background:#252A2D}}
.wrap{{position:relative;width:1280px;height:720px;overflow:hidden}}
.bg{{position:absolute;inset:0}}
.txt{{position:absolute;left:72px;top:150px;color:#fff;font-family:"Roboto Condensed","Arial Narrow",sans-serif;text-transform:uppercase}}
h1{{margin:0;font-size:104px;line-height:.95;font-weight:800;letter-spacing:.5px}}
h1 span{{color:#55C8BD}}
.bar{{display:inline-block;margin-top:30px;background:#55C8BD;color:#252A2D;font-weight:800;font-size:34px;padding:12px 44px 12px 24px;clip-path:polygon(0 0,100% 0,calc(100% - 24px) 100%,0 100%)}}
.geo{{margin-top:34px;font-family:Manrope,sans-serif;text-transform:none;font-weight:700;font-size:27px;color:rgba(255,255,255,.8)}}
.van{{position:absolute;right:28px;top:150px}}
.band{{position:absolute;left:0;right:0;bottom:0;height:12px;background:#55C8BD}}
</style>
<div class="wrap">
<svg class="bg" width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><defs>{hexpat}</defs>
<rect width="1280" height="720" fill="url(#hex)" opacity=".07"/>
<polygon points="560,720 900,0 1080,0 740,720" fill="#2F3539"/><polygon points="780,720 1120,0 1150,0 810,720" fill="#2F3539"/></svg>
<div class="txt"><h1>Грузовой<br><span>помощник</span></h1><div class="bar">Доставим. Перевезём. Поможем.</div>
<div class="geo">Новороссийск и Краснодарский край</div></div>
<svg class="van" width="560" height="440" viewBox="170 330 700 480" xmlns="http://www.w3.org/2000/svg">{van}</svg>
<div class="band"></div></div>'''

for name, html, size in (("avatar", avatar, "1024,1024"), ("welcome", banner, "1280,720")):
    src = HERE / f"{name}.html"
    src.write_text(html, encoding="utf-8")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=1", "--virtual-time-budget=5000",
                    f"--window-size={size}", f"--screenshot={HERE / (name + '.png')}", src.as_uri()],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print("ok", name + ".png")
