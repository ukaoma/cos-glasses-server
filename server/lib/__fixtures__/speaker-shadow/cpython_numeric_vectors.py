import json, random, math, re, sys
random.seed(20261028)
out = {'python': sys.version.split()[0], 'sum': [], 'round': [], 'fixed': [], 'roundInt': [], 'firstInt': [], 'voice': []}
def f(x): return x.hex()
for n in (1, 2, 3, 7, 50, 256):
    for _ in range(6):
        xs = [random.uniform(-1, 1) * 10 ** random.randint(-8, 8) for _ in range(n)]
        out['sum'].append({'xs': [f(x) for x in xs], 'sum': f(sum(xs))})
# adversarial cancellation
for _ in range(10):
    big = random.uniform(1e15, 1e16)
    xs = [big, 1.0, -big, 1e-3, random.uniform(-1, 1), -1.0, 3.3e-17]
    random.shuffle(xs)
    out['sum'].append({'xs': [f(x) for x in xs], 'sum': f(sum(xs))})
# products like cosdist
for _ in range(10):
    a = [random.gauss(0, 1) for _ in range(256)]; b = [random.gauss(0, 1) for _ in range(256)]
    na = math.sqrt(sum(x * x for x in a)); a = [x / na for x in a]
    nb = math.sqrt(sum(x * x for x in b)); b = [x / nb for x in b]
    out['sum'].append({'xs': [f(x * y) for x, y in zip(a, b)], 'sum': f(sum(x * y for x, y in zip(a, b)))})
ties = [0.125, 0.375, 0.625, 0.875, 2.5, 3.5, -0.125, 14.995, 0.0005, 0.12345, 1.005, 2.675, 0.7996, 0.4995, 0.5, -0.0, 1e-12, 123456.7891]
for x in ties + [random.uniform(0, 30) for _ in range(40)] + [k / 16000 for k in (2000, 6000, 10000, 239920, 240000, 239999)] + [n / d for n, d in ((399, 800), (1, 8), (3, 8), (7, 8), (5, 8))]:
    for nd in (1, 2, 3, 4):
        out['round'].append({'x': f(x), 'nd': nd, 'r': f(round(x, nd))})
        out['fixed'].append({'x': f(x), 'nd': nd, 's': '%.*f' % (nd, x)})
    out['fixed'].append({'x': f(x), 'nd': 0, 's': '%.0f' % x})
for x in [0.5, 1.5, 2.5, -0.5, -1.5, 3.4999999, 160000.5, 160001.5, 12345.678 * 16000] + [random.uniform(0, 4000) * 16000 for _ in range(30)]:
    out['roundInt'].append({'x': f(x), 'r': round(x)})
for s in ['Voice 12', 'Voice12', 'Voice ٣٤', 'Voice 𝟙𝟚', 'S10', 'Ext', 'Voice  7', 'Voice　 9', 'Voice\x1c3', 'Voice ﻿3', 'voice 3', 'Voice 3 ', 'Voice 3\n', 'Voice']:
    out['voice'].append({'s': s, 'm': bool(re.compile(r'Voice\s*\d+').fullmatch(s))})
    d = re.findall(r'\d+', s)
    out['firstInt'].append({'s': s, 'v': int(d[0]) if d else None})
print(json.dumps(out))
