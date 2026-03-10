const express = require("express");
const multer  = require("multer");
const AdmZip  = require("adm-zip");
const cors    = require("cors");
const path    = require("path");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

async function gh(endpoint, method, token, body = null) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "GitDeploy-App",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `GitHub ${res.status}`);
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "../public/index.html"))
);

app.post("/api/validate-token", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token diperlukan" });
  try {
    const user = await gh("/user", "GET", token);
    res.json({ valid: true, username: user.login, avatar: user.avatar_url });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.post("/api/deploy", upload.single("zipFile"), async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (type, data) =>
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);

  try {
    const { token, repoName, description, isPrivate, branch = "main" } = req.body;

    if (!token)    return send("error", { message: "Token GitHub diperlukan" });
    if (!repoName) return send("error", { message: "Nama repository diperlukan" });
    if (!req.file) return send("error", { message: "File ZIP diperlukan" });

    const repo = repoName.trim().replace(/\s+/g, "-");

    // Step 1: Validate token
    send("progress", { step: 1, message: "🔐 Memvalidasi token GitHub..." });
    const user = await gh("/user", "GET", token);
    const owner = user.login;
    send("progress", { step: 1, message: `✅ Login sebagai: ${owner}` });

    // Step 2: Create repository dengan auto_init: true
    // WAJIB auto_init:true agar git database ter-inisialisasi.
    // Tanpa ini, blob API akan error "Git Repository is empty".
    send("progress", { step: 2, message: `📁 Membuat repository: ${repo}...` });
    const newRepo = await gh("/user/repos", "POST", token, {
      name: repo,
      description: description || "",
      private: isPrivate === "true",
      auto_init: true,           // ← kunci utama fix
      default_branch: branch,
    });
    send("progress", { step: 2, message: `✅ Repository "${repo}" berhasil dibuat!` });

    // Tunggu sebentar agar GitHub selesai inisialisasi git database
    await sleep(1500);

    // Ambil SHA commit awal (dari README otomatis yang dibuat auto_init)
    // Ini diperlukan sebagai parent commit kita nanti
    send("progress", { step: 2, message: `🔍 Mengambil info branch awal...` });

    // Coba ambil branch yang diminta, fallback ke default branch repo
    let initCommitSha;
    let actualBranch = branch;

    try {
      const refData = await gh(`/repos/${owner}/${repo}/git/ref/heads/${branch}`, "GET", token);
      initCommitSha = refData.object.sha;
    } catch {
      // Branch belum ada (GitHub mungkin pakai 'main' atau 'master')
      const repoInfo = await gh(`/repos/${owner}/${repo}`, "GET", token);
      actualBranch = repoInfo.default_branch;
      const refData = await gh(`/repos/${owner}/${repo}/git/ref/heads/${actualBranch}`, "GET", token);
      initCommitSha = refData.object.sha;
    }

    send("progress", { step: 2, message: `✅ Branch "${actualBranch}" siap (SHA: ${initCommitSha.slice(0, 7)})` });

    // Step 3: Extract ZIP
    send("progress", { step: 3, message: "📦 Mengekstrak file ZIP..." });

    let entries;
    try {
      const zip = new AdmZip(req.file.buffer);
      entries = zip.getEntries().filter(e => !e.isDirectory);
    } catch {
      return send("error", { message: "File ZIP tidak valid atau rusak." });
    }

    if (entries.length === 0)
      return send("error", { message: "ZIP tidak mengandung file apapun." });

    // Strip common root folder (misal: "project-main/" → "")
    const allPaths = entries.map(e => e.entryName);
    const roots = [...new Set(allPaths.map(p => p.split("/")[0]))];
    const stripPrefix =
      roots.length === 1 && allPaths.every(p => p.startsWith(roots[0] + "/"))
        ? roots[0] + "/"
        : "";

    const files = entries.map(e => ({
      path: stripPrefix ? e.entryName.slice(stripPrefix.length) : e.entryName,
      data: e.getData(),
    })).filter(f => f.path);

    send("progress", {
      step: 3,
      message: `✅ Ditemukan ${files.length} file${stripPrefix ? ` (strip prefix: "${roots[0]}/")` : ""}`,
    });

    // Step 4: Buat blobs secara paralel per batch
    send("progress", {
      step: 4,
      message: `🔄 Membuat blob untuk ${files.length} file...`,
      total: files.length,
    });

    const BLOB_BATCH = 8;
    const blobResults = [];
    const blobFailed  = [];
    let blobDone = 0;

    for (let i = 0; i < files.length; i += BLOB_BATCH) {
      const batch = files.slice(i, i + BLOB_BATCH);

      const results = await Promise.allSettled(
        batch.map(async f => {
          const blob = await gh(
            `/repos/${owner}/${repo}/git/blobs`,
            "POST",
            token,
            { content: f.data.toString("base64"), encoding: "base64" }
          );
          return { path: f.path, sha: blob.sha };
        })
      );

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === "fulfilled") {
          blobResults.push(r.value);
          blobDone++;
        } else {
          blobFailed.push({ file: batch[j].path, reason: r.reason?.message || "unknown" });
          send("progress", {
            step: 4,
            message: `⚠️ Blob gagal [${batch[j].path}]: ${r.reason?.message}`,
          });
        }
      }

      send("progress", {
        step: 4,
        message: `🔄 Blob selesai: ${blobDone}/${files.length}`,
        blobDone,
        total: files.length,
      });

      if (i + BLOB_BATCH < files.length) await sleep(150);
    }

    if (blobResults.length === 0)
      return send("error", { message: "Semua file gagal diproses. Cek koneksi atau izin token." });

    // Step 5: Buat satu Git tree dari semua blob
    send("progress", { step: 4, message: `🌳 Membuat Git tree untuk ${blobResults.length} file...` });

    const treeItems = blobResults.map(b => ({
      path: b.path,
      mode: "100644",
      type: "blob",
      sha: b.sha,
    }));

    const tree = await gh(`/repos/${owner}/${repo}/git/trees`, "POST", token, {
      tree: treeItems,
      // Tidak pakai base_tree agar README bawaan auto_init diganti bersih
    });

    send("progress", { step: 4, message: "✅ Git tree berhasil!" });

    // Step 6: Buat satu commit dengan parent = commit awal dari auto_init
    send("progress", { step: 4, message: "💾 Membuat commit..." });

    const commit = await gh(`/repos/${owner}/${repo}/git/commits`, "POST", token, {
      message: `🚀 Initial commit — ${blobResults.length} file via GitDeploy`,
      tree: tree.sha,
      parents: [initCommitSha],   // ← pakai SHA commit awal sebagai parent
    });

    send("progress", { step: 4, message: "✅ Commit berhasil!" });

    // Step 7: Update ref branch yang sudah ada (PATCH, bukan POST)
    // Branch sudah ada karena auto_init, jadi harus di-update bukan di-create
    send("progress", { step: 4, message: `🌿 Update branch "${actualBranch}"...` });

    await gh(`/repos/${owner}/${repo}/git/refs/heads/${actualBranch}`, "PATCH", token, {
      sha: commit.sha,
      force: true,               // ← force update agar ref pindah ke commit kita
    });

    send("progress", { step: 4, message: `✅ Branch "${actualBranch}" berhasil diupdate!` });

    // Done
    const repoUrl = `https://github.com/${owner}/${repo}`;
    const summary = blobFailed.length > 0
      ? `🎉 Selesai! ${blobResults.length} file berhasil. ${blobFailed.length} file dilewati (lihat log).`
      : `🎉 Selesai! Semua ${blobResults.length} file berhasil diupload ke branch "${actualBranch}"!`;

    send("done", {
      message: summary,
      repoUrl,
      uploaded: blobResults.length,
      failed: blobFailed.length,
      failedFiles: blobFailed,
    });

  } catch (err) {
    let msg = err.message || "Terjadi kesalahan tidak diketahui";

    if (msg.includes("name already exists"))
      msg = "Repository dengan nama ini sudah ada. Gunakan nama yang berbeda.";
    else if (msg.includes("Secret detected") || msg.includes("secret scanning"))
      msg = "⚠️ GitHub mendeteksi secret/token dalam file kamu dan memblokir upload. Hapus API key / credential dari file-file tersebut, lalu coba lagi.";
    else if (msg.includes("Bad credentials"))
      msg = "Token GitHub tidak valid atau sudah expired. Buat token baru di github.com/settings/tokens";
    else if (msg.includes("rate limit"))
      msg = "GitHub rate limit tercapai. Tunggu 1-2 menit lalu coba lagi.";
    else if (msg.includes("Repository was archived"))
      msg = "Repository ini diarsipkan dan tidak bisa diubah.";

    send("error", { message: msg });
  } finally {
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 GitDeploy → http://localhost:${PORT}`)
);

module.exports = app;
