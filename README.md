# Tennis Live Dashboard

Lokální dashboard bez databáze. Server stahuje reálná data z veřejných zdrojů, krátce je drží v paměti a posílá je do jedné HTML stránky.

## Spuštění

```bash
npm start
```

Potom otevři:

```text
http://127.0.0.1:4173/
```

## Nasazení na Cloudflare

Projekt má připravený Cloudflare Worker v `src/worker.js`. Statický frontend se servíruje z `public/` a API běží na `/api/dashboard`.

```bash
npm run cf:check
npm run cf:deploy
```

## Co dashboard ukazuje

- dnešní French Open zápasy
- výsledky French Open za posledních 7 dní
- ATP Top 10
- H2H historii u dnešních zápasů
- jednoduchou testovací predikci výsledku

## Zdroje dat

- Roland-Garros order of play a výsledky
- ESPN ATP rankings
- Jeff Sackmann / Tennis Abstract historická ATP/WTA data

## Poznámka

Predikční model je jen testovací a vysvětlitelný prototyp. Není to sázkové doporučení.
