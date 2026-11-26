# Panduan server GME CHAIN

Satu VPS Hostinger menjalankan semuanya lewat Docker Compose di [`deploy/vps/`](../deploy/vps).

| Service | Profile | Isi |
| --- | --- | --- |
| `web` | (default) | Website `gmechain.xyz`, file statis dari `site/` |
| `nitro` | `chain` | Node mainnet (sequencer, batch poster, validator BoLD), RPC `rpc.gmechain.xyz` |
| `keeper` | `chain` | Update harga GME ke fee pricer mainnet |
| `monitor` | `chain` | Cek kesehatan chain, saldo operator, alert |
| `nitro-testnet` | `testnet` | Node testnet, RPC `rpc.testnet.gmechain.xyz` |
| `faucet` | `testnet` | "Get test kit" di `gmechain.xyz/api/faucet` |
| `pulse` | `testnet` | Transaksi tes kecil tiap beberapa menit, supaya explorer testnet selalu hidup |

## Server

- Hostinger **KVM 4**, Boston, IP `2.24.205.219`, template **Ubuntu 24.04 with Coolify**.
- Traefik milik Coolify memegang port 80/443 dan sertifikat HTTPS. Service GME CHAIN ikut network `coolify` dan diarahkan lewat label, jadi pakai `docker-compose.coolify.yml`.
- Project ada di `/opt/gmechain`. Jangan sentuh `/opt/agent-utility` (project lain).
- DNS di Cloudflare, semuanya A record ke `2.24.205.219`, mode DNS only: `@`, `www`, `rpc`, `rpc.testnet`.

```bash
cd /opt/gmechain/deploy/vps
docker compose -f docker-compose.coolify.yml up -d web
docker compose -f docker-compose.coolify.yml --profile chain up -d
docker compose -f docker-compose.coolify.yml --profile testnet up -d
docker compose -f docker-compose.coolify.yml ps
```

`deploy/vps/.env` di server berisi `SITE_HOST=gmechain.xyz`, `RPC_HOST=rpc.gmechain.xyz`, `RPC_TESTNET_HOST=rpc.testnet.gmechain.xyz` dan opsional `SITE_ALIAS`.

## File rahasia di server

Tidak pernah di-commit. Semua `chmod 600`.

| File | Isi |
| --- | --- |
| `chain/nodeConfig.mainnet.json` | Kunci batch poster + validator mainnet, URL RPC parent (Alchemy). Owner `1000:1000` |
| `chain/nodeConfig.testnet.json` | Sama, untuk testnet |
| `deploy/vps/secrets/keeper.env`, `monitor.env` | Kunci keeper, setting monitor dan alert |
| `deploy/vps/secrets/faucet.env`, `pulse.env` | Kunci faucet dan pulse (testnet saja) |

Kunci deployer tidak pernah ada di server; deploy kontrak dikerjakan dari laptop.

## Update website

`site/` di-mount langsung ke container `web`, jadi cukup ganti isinya. **Sinkronkan di tempat** (rsync), jangan ganti foldernya, karena container tetap memegang folder lama.

```bash
# dari laptop, satu koneksi: kirim arsip lewat stdin lalu sinkronkan
tar -czf - -C site . | ssh root@2.24.205.219 'D=$(mktemp -d); tar -xzf - -C $D; rsync -a --delete $D/ /opt/gmechain/site/; rm -r $D'
```

Hostinger membatasi koneksi SSH beruntun dari satu IP; kalau port 22 tiba-tiba timeout, tunggu 5 sampai 10 menit. Satukan pekerjaan dalam satu sesi SSH.

## Launch mainnet

Alamat mainnet sudah terisi di `site/js/config.js`. Saat launch:

1. Ubah `export const MAINNET_OPEN = false;` jadi `true` di `site/js/config.js`.
2. Upload ulang `site/`. Website langsung pindah ke mainnet, dan testnet tetap bisa dibuka lewat `?net=testnet`.

## Operasional

```bash
cd /opt/gmechain/deploy/vps
docker compose -f docker-compose.coolify.yml logs --tail 100 nitro      # node mainnet
docker compose -f docker-compose.coolify.yml logs --tail 100 keeper
docker compose -f docker-compose.coolify.yml logs --tail 50 pulse
docker compose -f docker-compose.coolify.yml restart nitro
```

- **Backup data chain**: volume `gmechain_nitro_data` (testnet: `gmechain_nitro_testnet_data`). Hentikan node dulu, lalu `docker run --rm -v gmechain_nitro_data:/d -v /root:/b alpine tar -czf /b/nitro-backup.tgz -C /d .`
- **Saldo operator**: batch poster dan validator membayar gas ETH di Robinhood Chain. Isi ulang dari deployer (`node chain/scripts/fund-operators.js --mainnet`) saat monitor memberi peringatan. Faucet testnet diisi dengan `FUND_FAUCET` dan `FUND_FAUCET_TGME` di skrip yang sama.
- **Alert**: isi `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID` di `secrets/monitor.env`, lalu `up -d monitor`.
- **Parent RPC node** harus archive dan mendukung `eth_getLogs` rentang lebar (Alchemy). RPC resmi Robinhood tidak menyimpan state lama, dan validator butuh itu.

## Keamanan

- Login SSH pakai key; matikan login password (`PasswordAuthentication no` di `/etc/ssh/sshd_config`).
- Port node (8449/8548) tidak dibuka ke internet; publik hanya lewat Traefik.
- Di server hanya ada kunci batch poster, validator, keeper, faucet dan pulse. Kunci deployer dan chain owner tetap di laptop (dan backup offline).
