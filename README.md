# 🚀 GitDeploy — ZIP to GitHub

Website untuk upload file ZIP langsung ke GitHub repository baru. Cocok buat yang sering deploy ke Vercel, Netlify, dll.

## Fitur
- ✅ Buat repository GitHub baru (public/private)
- ✅ Upload file ZIP → otomatis ekstrak
- ✅ Push semua file ke GitHub via API
- ✅ Real-time progress log terminal
- ✅ Strip root folder otomatis (misal: `project-main/`)
- ✅ Rate limiting friendly (upload batch)

## Setup & Deploy ke Vercel

### 1. Clone / Upload project ini ke GitHub

### 2. Install dependencies (untuk local dev)
```bash
npm install
npm run dev
# Buka http://localhost:3000
```

### 3. Deploy ke Vercel
```bash
npm i -g vercel
vercel
```
Atau connect repo di [vercel.com](https://vercel.com).

## Cara Pakai
1. Buka website
2. Masukkan **GitHub Personal Access Token** (butuh scope: `repo`)
   - Buat di: https://github.com/settings/tokens/new
3. Isi nama repository & deskripsi
4. Upload file `.zip` project kamu
5. Klik **DEPLOY** — selesai! 🎉

## Membuat GitHub Token
1. Buka https://github.com/settings/tokens/new
2. Centang scope: **`repo`** (full control)
3. Generate & copy token

## Stack
- **Backend**: Express.js + Multer + AdmZip
- **Frontend**: Vanilla HTML/CSS/JS (dark terminal aesthetic)
- **Deploy**: Vercel Serverless Functions
