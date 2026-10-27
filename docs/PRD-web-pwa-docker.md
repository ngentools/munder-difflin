# PRD: Web / PWA Mode (Docker-ready)

| | |
|---|---|
| **Status** | Draft — implemented on branch `feat/web-pwa-docker`, pending review |
| **Owner** | Munder Difflin maintainers |
| **Last updated** | 2026-10-27 |
| **Related code** | `src/main/webBridge.ts`, `src/main/index.ts` (2 lines), `web/`, `Dockerfile`, `docker-compose.yml` |

---

## 1. Ringkasan

Munder Difflin hari ini hanya berjalan sebagai aplikasi desktop Electron. Fitur ini
menambahkan **mode web/PWA**: UI yang **sama persis** dapat dibuka di browser
(dan di-install sebagai Progressive Web App), sementara logika berat tetap berjalan
di proses main Electron yang di-*headless*-kan. Mode ini dapat dijalankan secara
lokal untuk pengembangan (dengan hot reload) maupun di dalam Docker melalui
`docker compose`.

Prinsip utama: **tanpa mengubah fungsi yang sudah ada**, dengan pendekatan KISS.
Fungsi harus tercapai; kesempurnaan (misal parity 100% setiap fitur OS) bukan
prioritas pada rilis pertama.

## 2. Latar belakang & masalah

- Pengguna ingin mengakses app dari browser (mis. laptop tanpa instalasi, mesin
  remote, atau tim yang ingin satu instance bersama) tanpa memasang Electron.
- Renderer sudah tidak mengimpor `electron`, `fs`, atau `child_process` secara
  langsung; seluruh akses ke main melalui satu bridge `window.cth` (preload,
  ±190 method, ±163 channel IPC). Ini membuat renderer relatif mudah dipindah ke
  browser.
- Main process (±23k baris) memegang kemampuan yang tidak tersedia di browser:
  `node-pty` (terminal agent), `child_process` (menjalankan CLI agent), SQLite,
  akses file dan git worktree. Kemampuan ini **harus tetap berjalan di server**.
- Belum ada cara standar untuk menjalankan app tanpa display/desktop, sehingga
  deployment (Docker/server) tidak tersedia.

## 3. Tujuan (Goals)

1. **G1 — Visual identik:** UI di browser dirender dari kode renderer yang sama
   dengan desktop (tidak ada UI kedua).
2. **G2 — Fungsi tidak berubah:** semua channel IPC dijalankan oleh handler main
   yang sama, tanpa menulis ulang logika bisnis.
3. **G3 — PWA:** dapat di-install dari browser; app shell tersedia (cache).
4. **G4 — Hot reload untuk pengembangan** web mode (`npm run dev:web`).
5. **G5 — Docker:** satu perintah `docker compose up --build` menjalankan mode web.
6. **G6 — Desktop tidak terpengaruh:** `npm run dev` / build desktop tetap sama.

## 4. Non-goals

- **Bukan** migrasi ke Svelte pada rilis ini. Renderer React dipakai apa adanya
  (keputusan KISS; lihat §12). Migrasi Svelte dapat dilakukan belakangan memakai
  kontrak transport yang sama.
- Bukan multi-tenant SaaS. Satu container = satu harness/data.
- Tidak menyediakan autentikasi multi-user, OAuth, atau manajemen akun.
- Tidak menjamin parity 100% untuk fitur yang bergantung pada OS (tray, global
  shortcut, auto-update, dialog native). Lihat §9.
- Tidak mengubah format data harness (`harnessHome`, config, SQLite).

## 5. Pengguna & skenario

| Persona | Kebutuhan |
|---|---|
| **Developer** (pengembang Munder Difflin) | Iterasi UI dengan hot reload di browser tanpa menjalankan Electron GUI. |
| **Pengguna mandiri** | Menjalankan app di server/mesin lain dan membukanya dari browser/PWA. |
| **Operator/tim** | Men-deploy dengan Docker Compose; data persisten lewat volume; akses dibatasi dengan token. |

**User stories**

- *US-1:* Sebagai developer, saya menjalankan `npm run dev:web` dan melihat perubahan
  renderer langsung (HMR) di `http://localhost:5174`.
- *US-2:* Sebagai pengguna, saya membuka `http://<host>:3900/?token=…` dan menggunakan
  app seperti di desktop (chat agent, terminal, kantor/hive, panel).
- *US-3:* Sebagai pengguna, saya meng-install app dari browser sebagai PWA.
- *US-4:* Sebagai operator, saya menjalankan `docker compose up --build` dengan
  `WEB_TOKEN` di `.env`, dan data tetap ada setelah container di-restart.
- *US-5:* Sebagai operator, akses dari jaringan lain hanya diizinkan jika token
  diset; tanpa token, server menolak start di luar loopback.

## 6. Requirement fungsional

| ID | Requirement | Prioritas | Status |
|---|---|---|---|
| FR-1 | Main process dapat dijalankan headless (`WEB_HEADLESS=1`) tanpa window desktop. | Must | ✅ |
| FR-2 | Setiap `ipcMain.handle` didaftarkan ke bridge HTTP `POST /api/<channel>`. | Must | ✅ |
| FR-3 | `ipcMain.on` (fire-and-forget dan sync) didukung via `/api/send/*` dan `/api/sync/*`. | Must | ✅ |
| FR-4 | Event main → renderer (`webContents.send`) diteruskan ke browser via Server-Sent Events `GET /events`. | Must | ✅ |
| FR-5 | Preload (`src/preload/index.ts`) berjalan tanpa diubah; `window.cth` tersedia di browser lewat shim `web/electron-shim.ts`. | Must | ✅ |
| FR-6 | Renderer di browser merender layar yang sama (onboarding, command center, kantor Pixi, terminal). | Must | ✅ (diverifikasi manual) |
| FR-7 | Dev mode dengan HMR: `npm run dev:web` (bridge + Vite). | Must | ✅ |
| FR-8 | Build PWA: manifest, ikon, service worker (precache app shell). | Must | ✅ build; install & offline belum diuji |
| FR-9 | Docker: Dockerfile multi-stage + `docker-compose.yml` + volume data. | Must | ✅ |
| FR-10 | Autentikasi token untuk akses non-loopback (`WEB_TOKEN`, cookie HttpOnly). | Must | ✅ |
| FR-11 | Desktop mode tanpa `WEB_HEADLESS` tidak berubah (`attachWebWindow` no-op). | Must | ✅ (typecheck lolos) |
| FR-12 | Sebagian besar channel diuji end-to-end (±163). | Should | ⚠️ parsial — lihat §10 |
| FR-13 | Install PWA dan mode offline diuji di browser. | Should | ⏳ belum |
| FR-14 | Dialog file/folder native dan drag-drop berpath lokal berfungsi di web. | Could | ❌ tidak didukung (lihat §9) |

## 7. Requirement non-fungsional

- **Keamanan:** bridge mengekspos akses shell (pty), filesystem, dan git. Default
  bind `127.0.0.1`. Non-loopback wajib `WEB_TOKEN`. Semua request harus dari origin
  yang sama atau localhost; POST wajib header `X-CTH-Bridge`.
- **Persistensi:** semua state app berada di `HOME` (`/data/home` di container),
  sehingga satu volume mencakup config, hive, dan memori agent.
- **Portabilitas:** Linux (container) dan macOS (dev). Windows belum diuji untuk
  mode web.
- **Performa:** bundle renderer ±6,5 MB (sama seperti desktop); precache PWA
  ±15 MB. Belum ada code-splitting (di luar cakupan rilis pertama).
- **Ketahanan:** container `restart: unless-stopped`, healthcheck HTTP, `tini`
  sebagai init untuk membersihkan proses anak (PTY agent).
- **Kompatibilitas native:** `better-sqlite3` dan `node-pty` dibangun untuk ABI
  Electron (`electron-rebuild`), bukan Node biasa.

## 8. Arsitektur

```
Browser (PWA)                                   Container / host
┌──────────────────────────┐   fetch POST /api/*   ┌──────────────────────────────┐
│ React renderer (sama)    │ ────────────────────▶ │ Electron main (WEB_HEADLESS) │
│ preload → window.cth     │                       │  - ipcMain.handle (163)      │
│ shim: electron → HTTP/SSE│ ◀──── GET /events ─── │  - webBridge.ts (HTTP + SSE) │
└──────────────────────────┘   (webContents.send)  │  - hive, pty, db, git, fs    │
                                                    └──────────────────────────────┘
```

**Komponen**

- `src/main/webBridge.ts` — mencegat `ipcMain.handle/on`, menyediakan HTTP + SSE,
  menyajikan `web/dist` (static), dan autentikasi token.
- `src/main/index.ts` — import bridge sebagai baris pertama; `attachWebWindow(win)`
  di `createWindow` (membuat `webContents.send` mengirim ke browser, menonaktifkan
  `loadURL`/`show`).
- `web/electron-shim.ts` — implementasi browser untuk `contextBridge`,
  `ipcRenderer` (`invoke`, `sendSync`, `on`, `removeListener`), dan `webUtils`.
- `web/vite.config.ts` — alias `electron` → shim; proxy `/api` dan `/events` ke
  bridge; plugin PWA; `define` untuk `process.platform/arch`.
- `web/index.html`, `web/entry.ts` — entry web; `index.html` di-generate dari
  `src/renderer/index.html` (skrip entry diganti).

**Mengapa Electron headless (bukan server Node terpisah)?** Handler IPC dan native
module sudah ada dan terikat ke ABI Electron. Menjalankan main yang sama
menjamin fungsi identik dan menghindari penulisan ulang ±23k baris. Biaya:
image membutuhkan Electron runtime dan Xvfb.

## 9. Batasan yang diketahui

| Area | Perilaku di web mode | Alasan |
|---|---|---|
| Drag-drop file | Nama file tersedia, path kosong (`webUtils.getPathForFile` → `''`) | Browser tidak mengekspos path absolut. |
| Dialog native (pilih folder/file) | Belum diuji; kemungkinan tidak sesuai di server | Dialog terikat ke window desktop. |
| Tray, global shortcut, notifikasi OS | Tidak tersedia | Fitur OS desktop. |
| Auto-update (`electron-updater`) | Tidak berlaku; update PWA lewat service worker | Mekanisme berbeda. |
| Multi-window / floor | Satu klien browser utama; event dikirim ke semua klien SSE | Model window tidak dipetakan. |
| Config asal Mac | Path absolut macOS tidak valid di container | Data container mulai kosong. |
| Agent CLI (`claude`, dll.) | Harus tersedia di image (`AGENT_CLI_PACKAGES`) | Tidak di-bundle secara default. |
| Mode offline | App shell di-cache, tetapi fitur agent butuh koneksi bridge | Logika ada di server. |

## 10. Status pengujian

**Sudah diverifikasi**
- `npm run build:web` berhasil; PWA menghasilkan 106 entri precache dan `sw.js`.
- `npm run typecheck:node` lolos tanpa error.
- `npm run dev:web`: UI tampil (onboarding/harness picker), console tanpa error
  setelah cache Vite dibersihkan; command center dan kantor Pixi tampil; terminal
  pty mengalirkan output lewat SSE.
- Docker: image berhasil dibuild (arm64); container `healthy`.
- Auth: tanpa token → 401 (`/events`, `/api`); token salah → 401; token benar →
  302 + cookie HttpOnly; API dengan cookie → 200.
- Docker UI: onboarding tampil di browser setelah login token.

**Belum diverifikasi**
- Install PWA dan perilaku offline.
- Sebagian besar channel IPC individual (±163) — perlu test paritas.
- Dialog native dan alur yang memakai file dialog.
- Platform: Windows; Linux non-container.
- Beban (beberapa klien SSE, banyak terminal sekaligus).

**Catatan operasional yang ditemukan saat pengujian**
- `npm ci` gagal karena lockfile tidak sinkron dengan `package.json`; Dockerfile
  memakai `npm install`.
- `better-sqlite3`/`electron` dibangun gagal di Node 26 pada sistem pengembang;
  instalasi harus memakai Node 20/24 (`electron` 32).
- Lockfile memuat dependensi `git+ssh://` (`@electron/node-gyp`); Dockerfile
  mengarahkannya ke HTTPS (`insteadOf`).

## 11. Konfigurasi

| Variabel | Default | Keterangan |
|---|---|---|
| `WEB_HEADLESS` | — | `1` mengaktifkan mode web. Wajib untuk bridge. |
| `WEB_HOST` | `127.0.0.1` | Alamat bind. Non-loopback wajib `WEB_TOKEN`. |
| `WEB_PORT` | `3900` | Port bridge. |
| `WEB_TOKEN` | — | Token akses. Disimpan sebagai cookie setelah `/?token=…`. |
| `WEB_DIST` | `<app>/web/dist` | Lokasi build PWA yang disajikan. |
| `WEB_HOST_PORT` | `3900` | Port di host (compose), hanya dipakai `docker-compose.yml`. |
| `AGENT_CLI_PACKAGES` | kosong | Build arg: paket npm CLI agent yang dipasang global. |

## 12. Keputusan & alasan

| Keputusan | Alasan | Alternatif yang ditolak |
|---|---|---|
| Pakai renderer React yang ada, bukan Svelte | KISS; visual & fungsi identik tanpa rewrite ±37k baris. | Rewrite Svelte penuh (mahal, berisiko, bertentangan dengan prioritas "fungsi tercapai"). |
| Jalankan Electron headless sebagai server | Reuse 100% handler IPC dan native module. | Server Node terpisah (perlu stub Electron, ABI native berbeda). |
| Transport HTTP POST + SSE | Sederhana, tanpa dependensi WebSocket; kompatibel dengan proxy Vite. | WebSocket (lebih banyak kode, tidak diperlukan). |
| Token + cookie HttpOnly | Cukup untuk satu operator; tidak butuh sistem akun. | Basic auth (tidak ramah untuk EventSource); OAuth (di luar scope). |
| `npm install` di Dockerfile | Lockfile tidak sinkron; `npm ci` gagal. | Regenerasi lockfile di PR ini (diperluas ke luar scope). |

## 13. Rencana rollout

1. **M1 — Review & merge** branch ini setelah test paritas minimum (§10) disepakati.
2. **M2 — Hardening:** test paritas channel, uji dialog/file, uji PWA install & offline,
   dokumentasi operator (volume, backup).
3. **M3 — Opsional:** code-splitting renderer, migrasi Svelte bertahap memakai
   transport yang sama.

## 14. Risiko

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Bridge mengekspos shell/fs | Akses tidak sah jika token bocor atau bind salah | Default loopback; refuse start non-loopback tanpa token; origin check; header kustom. |
| Agent berjalan di data asli | Agent aktif tanpa diminta | Dokumentasikan; gunakan volume terpisah di compose. |
| Fitur OS tidak tersedia | Pengguna desktop tidak mendapat parity | Desktop tetap jadi target utama; web jadi mode tambahan. |
| Native module ABI | Build gagal di mesin lain | Ikuti versi Node yang disarankan; Dockerfile sudah memakai Node 20. |
| Lockfile tidak sinkron | `npm ci` gagal di CI | Rapikan lockfile di PR terpisah. |

## 15. Pertanyaan terbuka

1. Apakah mode web perlu dukungan multi-user, atau cukup satu operator per instance?
2. Apakah tim ingin tetap mempertahankan rencana migrasi Svelte, atau React cukup?
3. Agent CLI mana yang harus ada di image default?
4. Apakah hosting publik direncanakan? Jika ya, diperlukan TLS (reverse proxy) dan
   kebijakan token yang lebih kuat.

## 16. Cara menjalankan

```bash
# Pengembangan (hot reload)
npm run dev:web            # bridge + Vite; buka http://localhost:5174

# Produksi lokal (tanpa Docker)
npm run start:web          # build PWA + main; buka http://127.0.0.1:3900 (token opsional di loopback)

# Docker
cp .env.example .env       # isi WEB_TOKEN (openssl rand -hex 32)
docker compose up --build  # buka http://localhost:3900/?token=…
```
