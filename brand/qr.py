"""QR-коды бота с метками источника. Запуск:  python3 brand/qr.py
Метка (?start=car и т.п.) показывает Лёхе в заявке, откуда пришёл клиент."""
import pathlib, subprocess, json

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "qr"; OUT.mkdir(exist_ok=True)
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BOT = "https://t.me/gruz_pomoshnik_bot?start="
CARDS = [  # файл, метка, заголовок, подпись, размер
    ("qr-mashina", "car", "Нужна перевозка?", "Заявка за 2 минуты — наведите камеру", (1200, 1500)),
    ("qr-vizitka", "card", "Заявка в Telegram", "Наведите камеру телефона", (1050, 600)),
]

def page(src, title, sub, w, h):
    landscape = w > h
    q = int(min(w, h) * (0.78 if landscape else 0.5))
    return f'''<!doctype html><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@800&family=Manrope:wght@700&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>
<style>html,body{{margin:0;width:{w}px;height:{h}px;overflow:hidden;background:#252A2D;color:#fff}}
.w{{box-sizing:border-box;width:{w}px;height:{h}px;display:flex;{"flex-direction:row" if landscape else "flex-direction:column"};align-items:center;justify-content:center;gap:{int(min(w,h)*.07)}px;padding:{int(min(w,h)*.07)}px;border-bottom:{int(h*.02)}px solid #55C8BD}}
.t{{display:flex;flex-direction:column;gap:{int(min(w,h)*.03)}px;{"" if landscape else "align-items:center;text-align:center"}}}
h1{{margin:0;font:800 {int(min(w,h)*(.085 if landscape else .1))}px/1 "Roboto Condensed",Arial,sans-serif;text-transform:uppercase}}
h1 span{{color:#55C8BD}}
p{{margin:0;font:700 {int(min(w,h)*.045)}px/1.25 Manrope,Arial,sans-serif;color:rgba(255,255,255,.85)}}
.b{{font:700 {int(min(w,h)*.04)}px Manrope,Arial,sans-serif;color:#55C8BD}}
.q{{background:#fff;border-radius:{int(q*.06)}px;padding:{int(q*.06)}px;line-height:0}}
.q svg{{width:{q}px;height:{q}px}}</style>
<div class="w"><div class="q" id="q"></div><div class="t"><h1>Грузовой<br><span>помощник</span></h1><p>{title}</p><p>{sub}</p><div class="b">@gruz_pomoshnik_bot</div></div></div>
<script>var g=qrcode(0,"M");g.addData({json.dumps(BOT+src)});g.make();
document.getElementById("q").innerHTML=g.createSvgTag({{cellSize:8,margin:0,scalable:true}});</script>'''

for name, src, title, sub, (w, h) in CARDS:
    import time; f_time = time.time()
    f = OUT / f"{name}.html"; f.write_text(page(src, title, sub, w, h), encoding="utf-8")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                    "--virtual-time-budget=6000", f"--window-size={w},{h}", f"--screenshot={OUT / (name + '.png')}", f.as_uri()],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)  # Chrome иногда выходит с кодом 2, но снимок пишет
    png = OUT / (name + ".png"); f.unlink()
    assert png.exists() and png.stat().st_mtime > f_time, name; print("ok", png.name)
