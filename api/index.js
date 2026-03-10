const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const cors = require("cors");
const path = require("path");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ─── Helper: GitHub API request ─────────────────────────────────────────────
async function githubRequest(endpoint, method, token, body = null) {
  const url = `https://api.github.com${endpoint}`;
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "GitDeploy-App",
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || `GitHub API error: ${res.status}`);
  }
  return data;
}

// ─── Helper: encode buffer to base64 safely ─────────────────────────────────
function toBase64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

// ─── Helper: sleep for rate limiting ─────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Route: Serve frontend ───────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ─── Route: Validate GitHub Token ───────────────────────────────────────────
app.post("/api/validate-token", async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "Token diperlukan" });
  try {
    const user = await githubRequest("/user", "GET", token);
    res.json({ valid: true, username: user.login, avatar: user.avatar_url });
  } catch (err) {
    res.status(401).json({ error: "Token tidak valid: " + err.message });
  }
});

// ─── Route: Create Repo + Upload ZIP ────────────────────────────────────────
app.post("/api/deploy", upload.single("zipFile"), async (req, res) => {
  // Set headers for SSE (Server-Sent Events) so we can stream progress
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  try {
    const { token, repoName, description, isPrivate, branch = "main" } = req.body;

    // Validation
    if (!token) return sendEvent("error", { message: "Token GitHub diperlukan" });
    if (!repoName) return sendEvent("error", { message: "Nama repository diperlukan" });
    if (!req.file) return sendEvent("error", { message: "File ZIP diperlukan" });

    const sanitizedRepo = repoName.trim().replace(/\s+/g, "-");

    // Step 1: Validate token & get user
    sendEvent("progress", { step: 1, message: "🔐 Memvalidasi token GitHub..." });
    const user = await githubRequest("/user", "GET", token);
    sendEvent("progress", { step: 1, message: `✅ Login sebagai: ${user.login}` });

    // Step 2: Create repository
    sendEvent("progress", { step: 2, message: `📁 Membuat repository: ${sanitizedRepo}...` });
    await githubRequest("/user/repos", "POST", token, {
      name: sanitizedRepo,
      description: description || "",
      private: isPrivate === "true",
      auto_init: false,
    });
    sendEvent("progress", { step: 2, message: `✅ Repository "${sanitizedRepo}" berhasil dibuat!` });

    // Step 3: Extract ZIP
    sendEvent("progress", { step: 3, message: "📦 Mengekstrak file ZIP..." });
    let entries;
    try {
      const zip = new AdmZip(req.file.buffer);
      entries = zip.getEntries().filter((e) => !e.isDirectory);
    } catch (e) {
      return sendEvent("error", { message: "File ZIP tidak valid atau rusak." });
    }

    if (entries.length === 0) {
      return sendEvent("error", { message: "ZIP tidak mengandung file apapun." });
    }

    // Detect and strip common root folder (e.g. "project-main/")
    const allPaths = entries.map((e) => e.entryName);
    const firstSegments = [...new Set(allPaths.map((p) => p.split("/")[0]))];
    const hasCommonRoot = firstSegments.length === 1 && allPaths.every((p) => p.startsWith(firstSegments[0] + "/"));
    const stripPrefix = hasCommonRoot ? firstSegments[0] + "/" : "";

    sendEvent("progress", {
      step: 3,
      message: `✅ Ditemukan ${entries.length} file${stripPrefix ? ` (root folder "${firstSegments[0]}" akan di-strip)` : ""}`,
    });

    // Step 4: Upload files
    sendEvent("progress", { step: 4, message: `⬆️ Mengupload ${entries.length} file ke GitHub...` });

    let uploaded = 0;
    let failed = 0;
    const failedFiles = [];

    // Upload files in batches to avoid rate limiting
    const BATCH_SIZE = 5;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);

      await Promise.allSettled(
        batch.map(async (entry) => {
          const filePath = stripPrefix ? entry.entryName.replace(stripPrefix, "") : entry.entryName;
          if (!filePath) return; // skip if path becomes empty after strip

          const content = toBase64(entry.getData());
          try {
            await githubRequest(
              `/repos/${user.login}/${sanitizedRepo}/contents/${filePath}`,
              "PUT",
              token,
              {
                message: `feat: add ${filePath}`,
                content,
                branch,
              }
            );
            uploaded++;
            sendEvent("progress", {
              step: 4,
              message: `⬆️ [${uploaded}/${entries.length}] ${filePath}`,
              uploaded,
              total: entries.length,
            });
          } catch (err) {
            failed++;
            failedFiles.push({ file: filePath, reason: err.message });
            sendEvent("progress", {
              step: 4,
              message: `⚠️ Gagal upload: ${filePath} — ${err.message}`,
              uploaded,
              total: entries.length,
            });
          }
        })
      );

      // Small delay between batches to be gentle on rate limits
      if (i + BATCH_SIZE < entries.length) await sleep(300);
    }

    // Done
    const repoUrl = `https://github.com/${user.login}/${sanitizedRepo}`;
    sendEvent("done", {
      message: `🎉 Selesai! ${uploaded} file berhasil diupload${failed > 0 ? `, ${failed} gagal` : ""}.`,
      repoUrl,
      uploaded,
      failed,
      failedFiles,
    });
  } catch (err) {
    sendEvent("error", { message: err.message });
  } finally {
    res.end();
  }
});

// ─── Start server (for local dev) ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 GitDeploy running at http://localhost:${PORT}`);
});

module.exports = app;
