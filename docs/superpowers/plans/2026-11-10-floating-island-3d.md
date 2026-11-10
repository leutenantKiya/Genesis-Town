# Floating Island 3D: Rencana Implementasi

> **Untuk agen yang mengerjakan:** kerjakan per fase, berurutan. Setiap fase berakhir dengan game yang bisa dimainkan
> di `?view=3d` **dan** `?view=2d`. Langkah memakai checkbox (`- [ ]`). Jangan mulai fase berikutnya sebelum kriteria
> selesai fase sekarang terpenuhi dan dilaporkan.

**Tujuan:** Genesis Town tampil sebagai dunia 3D pulau melayang (desa publik dan setiap Homeland) memakai Three.js,
tanpa mengubah aturan permainan, server, kontrak, ekonomi, atau output generator peta.

**Arsitektur singkat:** Logika game tetap berbasis grid tile di `engine.js`. Kita menambah lapisan render kedua,
`client/js/r3d/`, yang membaca data yang sama (`scene.map`, `scene.npcs`, posisi pemain, jam game) dan menggambar
dunia 3D. Engine memilih renderer (`2d` atau `3d`) lewat satu sambungan. Mod lama tetap jalan lewat adapter, lalu
dipindah ke API 3D satu per satu.

**Tech stack:** three.js (versi dipin, dibundel esbuild di `client/build`, sama seperti `vendor/near.js`), plain
browser JS (tanpa build step untuk kode game), server Node tidak berubah.

---

## 1. Temuan kode yang menentukan rencana ini

| Fakta di kode | Akibatnya untuk 3D |
| --- | --- |
| `client/js/world/village.js` (3x3 chunk @32 = 96x96 tile) dan `world/homeland.js` (3x3 chunk @16 = 48x48) menghasilkan **data murni**, dan server memakainya untuk memvalidasi posisi pemain. | Generator **tidak boleh disentuh**. Semua bentuk pulau, tebing, dan dekorasi di luar peta adalah dekorasi render saja, di luar koordinat tile. |
| `engine.js` `render()` (sekitar baris 1905) adalah satu-satunya draw loop: cache statis `m.cache`, tile animasi, `onDrawGround`, entitas y-sort (NPC, pemain, kanopi pohon, tenda kios, `onEntities`), `drawNight()`, `onDraw`, transisi, `renderFx()` (label HTML). | Ini satu sambungan yang bersih: `render()` cukup memanggil renderer aktif. |
| `buildWorldCache(m)` (baris ~272) memanggang seluruh dunia (tanah, tepi air, bayangan, props, batang pohon, bangunan, fog area terkunci) ke satu canvas `m.cache` berukuran `m.w*T x m.h*T` (T = 12 px). | **Fase 1 bisa langsung memakai `m.cache` sebagai tekstur tanah**, jadi dunia 3D tampil lengkap sejak hari pertama. Bangunan dan props lalu dikeluarkan dari tekstur saat versi 3D-nya siap. |
| Mod menggambar dalam **koordinat layar**: `onDrawGround(ctx, camX, camY, T)`, `onDraw(ctx, camX, camY, T)`, `onEntities(ents, ctx, camX, camY, T)`, `GT.charDraw(...)`. Dipakai oleh `chain.js` (tanaman, monster, cuaca), `fishing.js`, `actfx.js`, `combat.js`, `homeland.js`, `players.js`, `charscreen.js`. | Butuh adapter (lihat bagian 4) agar semua mod tetap jalan di 3D, lalu migrasi bertahap ke API 3D. |
| Klik/tap ke dunia lewat **satu fungsi**: `GT.screenToTile(clientX, clientY)` (dipakai `mouse.js`). | Picking 3D = raycast ke bidang tanah di dalam fungsi yang sama. `mouse.js` tidak perlu berubah. |
| Label nama dan balon chat sudah HTML (`renderFx`, `elFx`), posisinya dihitung dari `camX/camY` dan skala `S`. | Cukup ganti perhitungan posisi dengan `tileToScreen()` dari renderer aktif. Teks tetap tajam. |
| Malam hari = overlay 2D (`drawNight`, `lightAt(gameMin)`, lampu dari `world.lamps`). Cuaca dan salju diatur `chain.js` (`GT.setSnow`, tint hujan). | Di 3D diganti cahaya sungguhan (hemisphere + matahari + point light lampu) dan partikel. Butuh satu event cuaca dari `chain.js`. |
| Homeland punya chunk bioma `sea` (pantai), chunk terkunci digambar di bawah fog, dan portal. Desa punya sungai utara-selatan, jembatan ke Dusun Seberang (proyek desa). | Chunk terkunci menjadi **pulau kecil terpisah** yang "berlabuh" saat dibuka. Sungai jatuh dari tepi pulau sebagai air terjun. |
| Interior bangunan adalah scene kecil terpisah (`enterBuilding`, `scene.kind !== 'out'`) dengan peta tile sendiri. | Interior tetap 2D dulu (lihat Keputusan 3). |
| `client/build/build.mjs` membundel `near-entry.js` menjadi `vendor/near.js` (IIFE). `client/sw.js` mem-precache daftar `SHELL`. | Three dibundel dengan cara yang sama menjadi `vendor/three.js` dan **hanya dimuat saat mode 3D aktif**. |

---

## 2. Keputusan desain (rekomendasi saya, perlu persetujuan)

1. **Gaya visual: HD-2D (direkomendasikan)** — dunia 3D low-poly (pulau, tebing, bangunan, pohon, air, cahaya) dengan
   karakter tetap sprite pixel art yang berdiri sebagai billboard. Alasannya: art karakter yang ada (skin, rambut, baju
   dari layar karakter, kilatan combat) tetap dipakai, risiko jauh lebih kecil, dan gayanya serasi dengan UI pixel.
   Alternatif: karakter 3D low-poly penuh (Fase 8, opsional, bisa memakai skill img2threejs dari gambar referensi).
2. **Kamera: ortografis miring tetap (direkomendasikan)**, sekitar 40° dari atas, mengikuti pemain tanpa dikunci ke
   tepi peta (supaya tepi pulau dan langit terlihat). Zoom terbatas (scroll di desktop; dua tingkat di ponsel). Rotasi
   90° ditunda: tombol panah "atas = utara" tetap benar dan adapter overlay tetap affine.
3. **Interior tetap 2D dulu.** Masuk bangunan = transisi gelap yang sudah ada, lalu renderer 2D. Interior 3D adalah
   pekerjaan terpisah setelah Fase 7.
4. **Chunk `sea` di Homeland menjadi laguna** di atas pulau, dengan air terjun di tepi pulau.
5. **Mode default:** `3d` bila WebGL2 tersedia dan pengujian performa awal lolos; `2d` sebagai fallback otomatis dan
   pilihan manual di Pengaturan. Selama pengembangan, default tetap `2d` dan 3D hanya lewat `?view=3d`.
6. **Dependensi baru: `three`** (satu-satunya). Ini pengecualian sadar terhadap aturan "no new npm dependency" di plan
   sebelumnya, karena Three.js memang diminta.

---

## 3. Batasan global (tidak boleh dilanggar)

- Jangan ubah: `server/`, `economy/`, `contracts/`, `client/js/world/*.js`, API `/api/*`, koordinat tile, collision,
  `SOLID`, pathfinding. Cek di akhir setiap fase: `git diff --stat main -- server economy contracts client/js/world`
  harus kosong.
- Mode `?view=2d` harus tetap identik dengan sebelumnya (bandingkan screenshot).
- Teks game tetap bahasa Indonesia; kode, komentar, dan docs bahasa Inggris (konvensi `CLAUDE.md`).
- Kontrol tetap: klik kiri/F, klik kanan/R, E, 1-7, scroll (hotbar; zoom memakai Ctrl+scroll atau tombol), L, T, C,
  tombol A/E dan D-pad di ponsel.
- Mod hanya bicara ke engine lewat `window.GT`. Renderer 3D juga hanya membaca state lewat `GT` dan beberapa getter
  baru yang ditambahkan engine (lihat 4.1).
- `?mode=offline` dan `npm run dev:mock` tetap jalan. `npm test` lulus di akhir setiap fase.
- Three.js dimuat malas (lazy): pemain mode 2D tidak mengunduhnya.
- Pixel art tetap tajam: tekstur dari canvas memakai `NearestFilter`, tanpa mipmap.
- Commit per fase di branch `floating-island-3d`, pesan satu kalimat bahasa Inggris tentang apa yang didapat pemain,
  diakhiri `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## 4. Arsitektur

### 4.1 Sambungan di engine (`engine.js`)

- [ ] Pisahkan `render()` menjadi `render2d()` (isi lama, tidak diubah) dan `render()` yang memanggil
      `activeRenderer.render(dt)`; renderer 2D adalah default.
- [ ] Tambah ke `GT`:
  - `GT.view` (getter: `'2d'|'3d'`), `GT.setView(v)` (simpan di `localStorage`, `?view=` menimpa).
  - `GT.registerRenderer(name, impl)` dengan `impl = {init(canvasHost), dispose(), render(frameInfo), resize(w,h),
    screenToTile(cx,cy), tileToScreen(x,y,h), onWorld(map), onScene(scene)}`.
  - `GT.frameInfo()` mengembalikan data yang dibutuhkan renderer tanpa membuka variabel internal:
    `{scene, map, npcs, player:{x,y,fx,fy,t,moving,dir,step}, gameMin, light, dark, lamps, timeAcc, snow, tr}`.
  - `GT.tileToScreen(x, y, h)` (dipakai `renderFx` dan mod), `GT.screenToTile` mendelegasikan ke renderer aktif.
- [ ] `buildWorldCache(m, opts)` menerima `opts.layers` (`ground`, `props`, `buildings`, `fog`) sehingga 3D bisa
      meminta tekstur tanah tanpa bangunan/props yang sudah punya versi 3D. Default = semua (perilaku lama).
- [ ] `renderFx()` memakai `tileToScreen` dari renderer aktif, bukan `camX/camY` langsung.
- [ ] Event baru: `GT.emit('weather', {kind, snow})` dari `chain.js` (satu baris di tempat cuaca sudah dihitung).

### 4.2 Lapisan render 3D (`client/js/r3d/`)

| File | Isi |
| --- | --- |
| `r3d/boot.js` | Deteksi WebGL2, lazy-load `vendor/three.js`, daftarkan renderer, fallback ke 2D + toast bila gagal. |
| `r3d/core.js` | `WebGLRenderer`, scene, kamera ortho, resize, loop render, kualitas (pixel ratio, bayangan). |
| `r3d/coords.js` | Konversi tile ↔ dunia (`tile (x,y)` → `(x+0.5, h, y+0.5)`, 1 tile = 1 unit), raycast picking, `tileToScreen`. |
| `r3d/island.js` | Bentuk pulau: tanah, tepi tebing berlapis, sisi bawah meruncing, akar, kristal, batu melayang. |
| `r3d/ground.js` | Mesh tanah per chunk dengan tekstur dari `m.cache`, lapisan decal untuk `onDrawGround`. |
| `r3d/props.js` | Pohon, batu, semak, pagar, lampu, tong, peti, rambu, bunga: `InstancedMesh` per jenis. |
| `r3d/buildings.js` | Bangunan prosedural per `kind` (lihat Fase 3). |
| `r3d/water.js` | Air (sungai, kolam, danau, laguna), air terjun di tepi pulau, kabut percikan. |
| `r3d/sky.js` | Gradasi langit dari jam game, matahari/bulan, bintang, awan berlapis, pulau jauh. |
| `r3d/actors.js` | Billboard karakter (NPC, pemain, pemain lain, bot) dari sprite pixel, bayangan bulat. |
| `r3d/fx.js` | API efek 3D untuk mod: partikel, teks melayang, kilatan, guncangan kamera. |
| `r3d/compat.js` | Adapter mod lama (bagian 4.3). |
| `r3d/weather.js` | Hujan, salju, tint, salju di atap dan tanah. |

Script dimuat lewat `boot.js` setelah `engine.js`; `index.html` hanya menambah `r3d/boot.js`. Semua file r3d lain
dimuat oleh `boot.js` saat mode 3D aktif, dan ditambahkan ke `SHELL` di `sw.js`.

### 4.3 Kompatibilitas mod (adapter, sementara)

| Hook lama | Di mode 3D |
| --- | --- |
| `onDrawGround(ctx, camX, camY, T)` (tanaman, riak ikan) | Digambar ke **canvas decal ruang-dunia** (jendela tile di sekitar kamera, `camX/camY` = asal jendela), dipasang sebagai tekstur transparan tepat di atas tanah. Hasilnya benar secara 3D karena memang benda di tanah. |
| `onDraw(ctx, camX, camY, T)` (monster, ayunan kapak, angka, topi, timer) | Canvas 2D transparan di atas canvas WebGL; `ctx.setTransform(...)` diisi proyeksi affine bidang tanah dari kamera ortho, lalu mod dipanggil dengan `camX = camY = 0`. Posisi tepat; benda tegak tampak sedikit miring. **Sementara**, sampai mod dipindah ke `fx.js` (Fase 6). |
| `onEntities(ents, ...)` (`players.js`) | Entri boleh membawa field data baru `char:{x, y, look, dir, step}` di samping `draw`. Renderer 3D memakai `char` untuk billboard; renderer 2D tetap memakai `draw`. `players.js` diubah untuk mengisi `char`. |
| `GT.charDraw` (kilatan combat, tampilan karakter) | Billboard karakter digambar dengan memanggil `GT.charDraw`/`drawChar` ke canvas kecil 16x20 per aktor, hanya saat kuncinya berubah (`look, dir, step, flash`). |
| Kanopi pohon, tenda kios | Diganti versi 3D di Fase 3; sampai saat itu billboard dari sprite yang sama. |

---

## 5. Fase pekerjaan

### Fase 0: Fondasi dan sambungan

- [ ] Tambah `three` (versi stabil terbaru, dipin persis) ke `client/build/package.json`; entri `three-entry.js` yang
      mengekspor `window.THREE` (plus `BufferGeometryUtils` bila dipakai); `build.mjs` membangun `vendor/three.js`.
      `npm run setup` di Windows tetap bersih.
- [ ] Sambungan engine di 4.1 (`render2d`, `registerRenderer`, `frameInfo`, `tileToScreen`, `setView`).
- [ ] `r3d/boot.js` + `r3d/core.js`: canvas WebGL di dalam `#fit` di belakang canvas 2D; `?view=3d` menampilkan
      langit polos dan kotak uji di posisi pemain.
- [ ] Pengaturan (`settings.js`): "Tampilan: 2D / 3D" dan "Kualitas 3D: Rendah / Sedang / Tinggi".

**Selesai bila:** `?view=2d` identik dengan `main` (screenshot), `?view=3d` jalan tanpa error konsol, kegagalan WebGL
jatuh ke 2D dengan toast.

### Fase 1: Pulau melayang yang bisa dimainkan (HD-2D minimum)

- [ ] `ground.js`: tanah = mesh per chunk, tekstur `m.cache` (`CanvasTexture`, `NearestFilter`), diperbarui saat
      `buildWorldCache` dipanggil ulang (salju, chunk dibuka).
- [ ] `island.js`: tepi pulau berbentuk noise berseed **di luar** persegi peta (2-6 tile dekorasi), tebing berlapis
      (rumput, tanah, batu), sisi bawah meruncing dengan stalaktit batu, akar menggantung, kristal kecil bercahaya.
      Sedikit bobbing (0.05 unit) dan bayangan lembut di awan.
- [ ] `sky.js` versi awal: gradasi langit dari `light/dark`, dua lapis awan parallax, 3-5 pulau jauh bergoyang.
- [ ] `coords.js` + kamera ortho miring mengikuti pemain dengan smoothing; zoom terbatas.
- [ ] `actors.js`: billboard karakter untuk pemain, NPC, pemain lain (`char` dari `onEntities`), bot Homeland.
- [ ] `compat.js`: decal `onDrawGround` dan overlay affine `onDraw`.
- [ ] `GT.screenToTile` lewat raycast; `renderFx` lewat `tileToScreen`.

**Selesai bila:** di desa dan Homeland pemain bisa jalan, klik untuk berjalan dan bertindak, menebang, memancing,
bertani, membuka kios, masuk bangunan (interior 2D), keluar lagi; label nama dan chat di tempat yang benar; tepi
pulau dan langit terlihat di ujung peta. Screenshot desktop dan ponsel.

### Fase 2: Air dan air terjun

- [ ] `water.js`: tile air (sungai, kolam, danau, `sea` Homeland) sebagai mesh sendiri sedikit di bawah tanah, shader
      sederhana (gelombang, warna dangkal/dalam, kilau), tepi busa.
- [ ] Di setiap tempat air menyentuh tepi peta (ujung utara dan selatan sungai, laguna Homeland), air tumpah dari
      tebing: mesh air terjun bertekstur bergerak + kabut percikan di bawah pulau.
- [ ] Riak ikan (`fishing.js` lewat decal) tetap terlihat di atas air.

**Selesai bila:** sungai mengalir dan jatuh dari kedua ujung pulau; memancing tetap jalan.

### Fase 3: Bangunan dan props 3D

- [ ] `buildings.js`: bangunan prosedural low-poly per `kind` memakai `b.x, b.y, b.w, b.h` dan pintu `b.dx, b.dy`:
      rumah (`b.style` menentukan warna atap/dinding, gembok bila `!b.invited`), Balai Desa (`hall`), gereja (`church`),
      Puskesmas (`clinic`), Kantor Pos (`post`), Kantor Makelar (`broker`), Warung Kopi (`warung`), Mart, Kasino,
      Town Hall level 1-5, Kolam Ikan, Tambang, Restoran, Rumah Pekerja, Rumah Sakit, lot kosong Homeland. Palet dari
      `art.js`/`sprites.js`. Jendela emisif untuk malam.
- [ ] Kios pasar dengan tenda berwarna `st.color`, rambu, kotak surat, lampu jalan, pagar ladang, petak tanah.
- [ ] `props.js`: pohon (2-3 bentuk per `treeKind`), batu, semak, bunga, tong, peti, rumput tinggi sebagai
      `InstancedMesh`. Batang pohon dan bangunan dikeluarkan dari tekstur tanah (`opts.layers`).
- [ ] Bangunan atau pohon yang menutupi pemain menjadi transparan/siluet.

**Selesai bila:** tidak ada lagi bangunan atau pohon datar di tekstur tanah; FPS dicatat sebelum dan sesudah.

### Fase 4: Langit, cahaya, musim, cuaca

- [ ] Arah dan warna matahari dari jam game; bulan dan bintang malam; senja jingga.
- [ ] Malam: hemisphere light meredup, lampu jalan dan jendela menyala (maksimal 8 `PointLight` terdekat, sisanya
      sprite glow). `drawNight` tidak dipakai di 3D.
- [ ] Bayangan (hanya kualitas Sedang/Tinggi).
- [ ] `weather.js`: hujan (partikel garis + tint), salju (partikel + tanah dan atap putih lewat `setSnow`), cerah,
      berawan, terik; mendengarkan event `weather`.

**Selesai bila:** siklus 24 jam (pakai panel Dev untuk loncat jam) dan semua cuaca terlihat benar.

### Fase 5: Pulau terkunci, jembatan, portal

- [ ] Chunk terkunci (desa: Dusun Seberang dan lima lainnya; Homeland: chunk yang belum dibuka) dirender sebagai
      pulau kecil terpisah: turun 1-2 unit dan bergeser keluar, bergoyang, berselimut awan. Tidak bisa diklik.
- [ ] Saat chunk dibuka (`GT.setWorld` dengan `unlocked` baru, atau Homeland membuka chunk): animasi "berlabuh"
      ±2 detik ke posisi aslinya, awan tersibak.
- [ ] Proyek jembatan selesai: jembatan 3D muncul menyambung ke Dusun Seberang.
- [ ] Portal: gapura batu 3D dengan pusaran shader; Homeland: gerbang di tepi pulau.

### Fase 6: Memindah efek mod ke 3D

- [ ] `fx.js` API: `GT.fx3d.burst(tile, kind)`, `.text(tile, str, color)`, `.flash(actor, color)`, `.shake(amount)`,
      `.billboard(id, tile, canvasDrawFn)`, `.line(fromTile, toTile, style)`.
- [ ] Pindahkan: `actfx.js` (ayunan kapak, serpihan kayu, daun), `fishing.js` (tali, pelampung, tanda "!"),
      `combat.js` + monster di `chain.js` (billboard monster, terjangan, kilatan, angka damage, guncangan kamera),
      `homeland.js` (topi, ikon sakit, timer builder, angka hasil panen), balon `players.js` (ke HTML).
- [ ] Setiap mod yang sudah pindah tidak lagi lewat overlay affine. Bila semua sudah, overlay hanya cadangan.

### Fase 7: Performa, ponsel, kualitas

- [ ] Target: 60 fps laptop biasa (Tinggi), 30+ fps ponsel menengah (Rendah). Dev overlay FPS dan draw calls.
- [ ] Rendah: pixel ratio 1, tanpa bayangan, awan satu lapis, air sederhana, partikel dikurangi.
- [ ] Geometri statis digabung per chunk, instancing, frustum culling, tekstur di-reuse, `dispose()` saat pindah
      dunia (desa ↔ Homeland) tanpa kebocoran memori (cek `renderer.info`).
- [ ] Layout ponsel portrait: kamera lebih dekat, tidak tertutup thumb zone; tablet portrait sama.
- [ ] Bila fps rata-rata < 20 selama 10 detik pertama, tawarkan pindah ke 2D.

### Fase 8 (opsional, perlu persetujuan): Karakter 3D

- [ ] Karakter low-poly bergaya blok dengan tampilan dari layar karakter (skin, rambut, baju), animasi jalan, diam,
      menebang, memancing, terkena serangan, pingsan.
- [ ] Untuk aset unggulan (karakter pemain, Town Hall), boleh memakai skill **img2threejs** bila pemilik memberi
      gambar referensi. Tanyakan dulu sebelum menjalankan pipeline-nya.

### Fase 9: Dokumentasi

- [ ] `README.md` blok status, `docs/architecture.md` (lapisan render), `CLAUDE.md` (baris `client/js/r3d/`).

---

## 6. Risiko dan cara menanganinya

| Risiko | Penanganan |
| --- | --- |
| Overlay affine membuat monster dan efek tegak tampak miring | Hanya sementara; Fase 6 memindahkannya. Prioritaskan `combat.js` dan monster. |
| Bangunan tinggi menutupi pemain | Fade/siluet (Fase 3). |
| Ponsel lemah atau baterai | Kualitas Rendah, fallback otomatis ke 2D, three dimuat malas. |
| Mod lain di masa depan menggambar dengan `camX/camY` | Dokumentasikan `GT.fx3d` dan `tileToScreen` di header `engine.js`; adapter tetap ada sebagai cadangan. |
| Perbedaan posisi visual vs tile logika | Semua posisi dari `frameInfo()` yang sama dengan render 2D (`lerpPos`), tidak ada simulasi gerak sendiri. |
| Generator atau server ikut berubah tanpa sengaja | Cek `git diff --stat` di batasan global setiap fase. |
| Ukuran unduhan bertambah (~600 KB three min) | Lazy-load hanya untuk mode 3D; network-first `sw.js` sudah ada. |

---

## 7. Verifikasi setiap fase

1. `npm test` lulus.
2. `git diff --stat main -- server economy contracts client/js/world` kosong.
3. Jalankan mock server. Di Windows `npm run dev:mock` gagal karena variabel env bergaya Unix; jalankan lewat Git Bash:
   `CHAIN_MODE=mock DEV_LOGIN=1 DB_PATH=data/mock.db GAME_CONTRACT_ID=game.genesistown.mock PLAYERS_PARENT_ACCOUNT_ID=players.genesistown.mock node server/src/main.ts`
4. Buka `http://localhost:3000/?view=3d` dan `?view=2d`, desktop dan ponsel (375x812). Jalur uji: masuk, jalan ke
   tepi pulau, memancing, menebang, bertani, jual ke Sari, masuk dan keluar rumah, portal ke Homeland dan kembali,
   malam (panel Dev), salju (`?musim=dingin`), chat.
5. Lapor: screenshot sebelum/sesudah, FPS, error konsol, apa yang belum diuji.

---

## 8. Prompt untuk memulai

```text
Kerjakan rencana docs/superpowers/plans/2026-11-10-floating-island-3d.md di branch floating-island-3d.
Baca dulu CLAUDE.md dan rencana itu sampai habis. Keputusan di bagian 2 sudah disetujui: <tulis keputusan atau
perubahan Anda di sini>. Mulai dari Fase 0. Di akhir setiap fase: jalankan semua langkah di bagian 7, commit, lalu
berhenti dan laporkan hasilnya sebelum lanjut ke fase berikutnya. Jangan ubah server/, economy/, contracts/, atau
client/js/world/. Kalau ada hal di rencana yang ternyata salah setelah membaca kodenya, berhenti dan tanyakan.
```
