const { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, Menu } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const exifr = require("exifr");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]);
const WALLPAPER_TARGET_WIDTH = 3840;
const WALLPAPER_TARGET_HEIGHT = 2160;
const WALLPAPER_TARGET_PIXELS = WALLPAPER_TARGET_WIDTH * WALLPAPER_TARGET_HEIGHT;
const MAX_RENDERER_PHOTOS = 160;

// Some Windows machines freeze Electron windows in packaged builds because of
// GPU driver or shader-cache issues. The app mostly renders still images, so
// software compositing is a safer default for release builds.
app.disableHardwareAcceleration();

// electron-builder's portable target is a self-extracting launcher. If a
// second portable launch hits Electron's single-instance lock, the extracted
// child exits while the launcher can keep waiting, which looks like a frozen
// release executable. Keep single-instance behavior for installed/zip builds,
// but let portable launches open independently.
const isPortableBuild = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
const hasSingleInstanceLock = isPortableBuild || app.requestSingleInstanceLock();

protocol.registerSchemesAsPrivileged([
  {
    scheme: "time-photo",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

const DEFAULT_CONFIG = {
  providerName: "OpenAI-compatible",
  protocol: "openai",
  baseUrl: "",
  apiKey: "",
  model: "gpt-4.1-mini",
  privacyMode: "feature_only",
  captionStyle: "克制、诗意、温柔",
  dailyLimit: 10,
  candidateLimit: 24,
  wallpaperCycleEnabled: false,
  wallpaperCycleIndex: 0,
  wallpaperCycleIntervalMs: 3600000,
  previousWallpaper: "",
  previousWallpaperStyle: "10",
  previousTileWallpaper: "0",
  previousWallpapers: "",
  autoLaunchEnabled: false,
  timeoutMs: 90000
};

const CAPTION_SYSTEM_PROMPT = `你是一个私人照片壁纸文案生成助手。

你的任务是根据照片的结构化信息，为用户生成适合叠加在桌面壁纸上的短文案。

你必须遵守以下规则：
1. 文案必须温柔、克制、有时间感和回忆感。
2. 文案只能基于输入中明确给出的信息，不得编造具体地点、人物身份、人物关系、事件、节日、旅行经历或情绪状态。
3. 不得使用“你和家人”“那年夏天你们去了某地”“这是你最幸福的一天”等未经确认的表达。
4. 不要直接描述照片内容成说明文，例如“这是一张有两个人站在海边的照片”。
5. 不要写得过度煽情、鸡汤、矫情、网络伤感文学化。
6. 不要出现恐怖、死亡、疾病、灾难、分离、遗憾等负面暗示，除非输入明确允许。
7. 文案长度控制在 12-28 个中文字符之间，最多不超过 40 个中文字符。
8. 每次输出 3 条候选文案。
9. 输出必须是严格 JSON，不要输出解释。`;

const BATCH_CAPTION_SYSTEM_PROMPT = `你是「时间壁纸」的私人照片文案策展人。

你的任务不是给照片贴标签，也不是写图片说明，而是为一组旧照片各写一句适合桌面壁纸展示的中文短文案。

核心审美：
1. 文案要像看完画面后心里多出来的一句话，而不是复述画面。
2. 可以有情绪、有余味、有文学感，但必须克制、准确、不油腻。
3. 更接近日常中的微妙情绪、轻微冷幽默、时间感、记忆感、看似平淡但有余味的一句判断。
4. 避免小学生作文式、网络伤感文学式、鸡汤式、套模板式表达。

事实边界：
1. 只能基于输入明确给出的信息和图片中可确认的信息。
2. 不得编造具体地点、人物身份、人物关系、事件、节日、旅行经历或情绪状态。
3. 不得使用“家人、恋人、朋友、孩子、幸福、遗憾、告别、永远”等未经确认或高风险词。
4. 不要出现恐怖、死亡、疾病、灾难、分离等负面暗示。

风格限制：
1. 尽量避免“世界、梦、时光、岁月、治愈、刚刚好、悄悄、慢慢”等高频套话。
2. 严禁使用这些套路句式：“……里……着整个世界”“……里……着整个夏天”“……得像……”“……比……还……”“……得比……更……”。
3. 不要出现“这张照片”“画面中”“照片里”“这一刻”“那天”等说明文指代。
4. 每句 8-26 个中文字符，最多不超过 34 个中文字符。

批量要求：
1. 必须为输入中的每一张照片生成结果，不能只生成 3 条。
2. 十张主文案之间不能有相似开头、相似结尾、相似句式或重复意象。
3. 每张照片输出 1 条主文案和 2 条备选文案。
4. 输出必须是严格 JSON，不要输出解释。`;

const SCORE_SYSTEM_PROMPT = `你是一个私人照片壁纸选片助手。

你的任务是只根据图片本身和少量结构化信息，为照片是否适合作为「旧日来信」壁纸打分。

评分原则：
1. 必须严厉惩罚模糊、失焦、手抖、曝光严重异常、主体被遮挡、构图杂乱、截图/票据/文件/纯文字、重复度高、视觉噪音重的照片。
2. 高分照片应当清晰、有可看的主体、有光线或氛围、有回忆感，且适合作为桌面壁纸长期观看。
3. 不要因为有人脸就自动高分；如果画质糊、构图差、表情/动作不适合展示，仍应低分。
4. 不要推断人物关系、地点、事件或情绪；只判断画面质量、壁纸适配度、记忆感和隐私安全。
5. safety_score 低于 60 表示不适合进入旧日来信。

输出必须是严格 JSON，不要输出解释。`;

const FALLBACK_CAPTIONS = [
  "光停了一会儿，像在等人认出它。",
  "平常被收好以后，也会有回声。",
  "风从旁边经过，留下很轻的一笔。",
  "有些安静，后来才显得郑重。",
  "日子没有解释，只把亮处留下。",
  "这一页很轻，却不急着翻过去。",
  "往回看时，普通也有了边框。",
  "影子短了一点，心事也短了一点。",
  "生活没说什么，却把光摆正了。",
  "旧日子靠近时，声音反而小了。"
];

const FORBIDDEN_WORDS = [
  "爸爸", "妈妈", "孩子", "爱人", "恋人", "朋友", "同事", "家人",
  "幸福", "痛苦", "遗憾", "告别", "重逢", "失去", "永远",
  "这张照片", "画面中", "照片里", "旅行", "学校", "医院"
];

const CLICHE_WORDS = ["世界", "梦", "治愈", "刚刚好", "这一刻", "那天"];

let mainWindow;
let dataPath;
let wallpaperCycleTimer = null;
let data = {
  folders: [],
  photos: [],
  analyses: {},
  config: { ...DEFAULT_CONFIG }
};

function photoUrl(id, version = "") {
  const suffix = version ? `?v=${encodeURIComponent(version)}` : "";
  return `time-photo://photo/${encodeURIComponent(id)}${suffix}`;
}

function publicPhoto(photo) {
  return {
    ...photo,
    fileUrl: photoUrl(photo.id, photo.lastModified || photo.size || ""),
    displayScore: combinedPhotoScore(photo)
  };
}

function publicPhotos(photos) {
  return photos.map(publicPhoto);
}

function publicPhotoPreviewList(photos) {
  return publicPhotos(photos.slice(0, MAX_RENDERER_PHOTOS));
}

function analysesForUi(photos) {
  const ids = new Set(photos.map((photo) => photo.id));
  const result = {};
  for (const id of ids) {
    if (data.analyses[id]) result[id] = data.analyses[id];
  }
  return result;
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  return "image/jpeg";
}

function registerPhotoProtocol() {
  protocol.handle("time-photo", async (request) => {
    const url = new URL(request.url);
    const id = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const photo = data.photos.find((item) => item.id === id);

    if (!photo || !fs.existsSync(photo.path)) {
      return new Response("Photo not found", { status: 404 });
    }

    let buffer;
    try {
      buffer = await fs.promises.readFile(photo.path);
    } catch {
      return new Response("Photo cannot be read", { status: 500 });
    }
    return new Response(buffer, {
      headers: {
        "Content-Type": mimeFromPath(photo.path),
        "Cache-Control": "no-store"
      }
    });
  });
}

function getDataPath() {
  return path.join(app.getPath("userData"), "time-wallpaper-data.json");
}

function loadData() {
  dataPath = getDataPath();
  try {
    if (fs.existsSync(dataPath)) {
      const loaded = JSON.parse(fs.readFileSync(dataPath, "utf8"));
      data = {
        folders: Array.isArray(loaded.folders) ? loaded.folders : [],
        photos: Array.isArray(loaded.photos) ? loaded.photos : [],
        analyses: loaded.analyses || {},
        config: { ...DEFAULT_CONFIG, ...(loaded.config || {}) }
      };
      for (const [photoId, analysis] of Object.entries(data.analyses)) {
        const isVisualCaption = analysis?.source === "llm_visual" || analysis?.source === "llm_visual_batch";
        const hasModelScore = Number.isFinite(Number(analysis?.score?.memory))
          && Number.isFinite(Number(analysis?.score?.wallpaper))
          && Number.isFinite(Number(analysis?.score?.safety));
        if ((!isVisualCaption || !analysis?.captions?.[0]?.text) && !hasModelScore) {
          delete data.analyses[photoId];
        }
      }
    }
  } catch (error) {
    console.error("Failed to load data", error);
  }
}

function saveData() {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), "utf8");
}

function sendWorkflowStatus(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("workflow:status", message);
  }
}

function autoLaunchOptions(enabled = Boolean(data.config.autoLaunchEnabled)) {
  const options = {
    openAtLogin: Boolean(enabled),
    openAsHidden: false
  };
  if (!app.isPackaged) {
    options.path = process.execPath;
    options.args = [app.getAppPath()];
  }
  return options;
}

function applyAutoLaunchSetting(enabled = Boolean(data.config.autoLaunchEnabled)) {
  if (process.platform !== "win32") return;
  try {
    app.setLoginItemSettings(autoLaunchOptions(enabled));
  } catch (error) {
    console.error("Failed to update auto launch setting", error);
  }
}

function readAutoLaunchEnabled() {
  if (process.platform !== "win32") return Boolean(data.config.autoLaunchEnabled);
  try {
    return Boolean(app.getLoginItemSettings(autoLaunchOptions()).openAtLogin);
  } catch {
    return Boolean(data.config.autoLaunchEnabled);
  }
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setAlwaysOnTop(false);
    mainWindow.focus();
  }, 250);
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: "#f7f3ec",
    title: "时间壁纸",
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#f7f3ec",
      symbolColor: "#315445",
      height: 36
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
    }
  }, 5000);

  mainWindow.on("unresponsive", () => {
    sendWorkflowStatus("窗口暂时无响应，正在等待当前任务完成。");
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else if (!app.isPackaged) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  mainWindow.setMenuBarVisibility(false);
}

function hashPhoto(filePath, stat) {
  return crypto
    .createHash("sha1")
    .update(`${filePath}|${stat.mtimeMs}|${stat.size}`)
    .digest("hex");
}

function normalizeExifDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function parseDateFromName(fileName, stat) {
  const match = fileName.match(/(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)/);
  if (match) {
    const [, year, month, day] = match;
    return {
      date: `${year}-${month}-${day}`,
      confidence: "medium",
      source: "filename"
    };
  }

  const date = new Date(stat.mtimeMs);
  return {
    date: date.toISOString().slice(0, 10),
    confidence: "low",
    source: "file_mtime"
  };
}

function formatCoordinate(lat, lon) {
  if (typeof lat !== "number" || typeof lon !== "number") return "";
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)}°${ns}, ${Math.abs(lon).toFixed(4)}°${ew}`;
}

function formatExposure(value) {
  if (!value || typeof value !== "number") return "";
  if (value >= 1) return `${value.toFixed(1)}s`;
  return `1/${Math.round(1 / value)}s`;
}

function estimateLocalImageQuality(filePath) {
  try {
    const source = nativeImage.createFromPath(filePath);
    if (source.isEmpty()) return { sharpness: 0, contrast: 0, label: "unreadable" };
    const size = source.getSize();
    const longestSide = Math.max(size.width, size.height);
    const scale = longestSide > 192 ? 192 / longestSide : 1;
    const image = scale < 1
      ? source.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: "good"
        })
      : source;
    const resizedSize = image.getSize();
    const width = resizedSize.width;
    const height = resizedSize.height;
    if (width < 24 || height < 24) return { sharpness: 0, contrast: 0, label: "too_small" };

    const bitmap = image.toBitmap();
    const gray = new Float32Array(width * height);
    let sum = 0;
    const histogram = new Uint32Array(32);
    let skinLike = 0;
    let colorfulSum = 0;
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4;
      const blue = bitmap[offset];
      const green = bitmap[offset + 1];
      const red = bitmap[offset + 2];
      const value = red * 0.299 + green * 0.587 + blue * 0.114;
      gray[index] = value;
      sum += value;
      histogram[Math.max(0, Math.min(31, Math.floor(value / 8)))] += 1;
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      colorfulSum += max - min;
      if (
        red > 95 && green > 40 && blue > 20
        && max - min > 15
        && Math.abs(red - green) > 15
        && red > green
        && red > blue
      ) {
        skinLike += 1;
      }
    }

    const mean = sum / gray.length;
    let contrastSum = 0;
    for (const value of gray) {
      const diff = value - mean;
      contrastSum += diff * diff;
    }
    const contrast = Math.sqrt(contrastSum / gray.length);
    let entropy = 0;
    for (const bucket of histogram) {
      if (bucket === 0) continue;
      const probability = bucket / gray.length;
      entropy -= probability * Math.log2(probability);
    }
    const entropyScore = Math.max(0, Math.min(100, Math.round((entropy / 5) * 100)));
    const brightnessScore = Math.max(0, Math.min(100, Math.round(100 - Math.abs(mean - 128) * 0.78)));
    const colorfulness = Math.max(0, Math.min(100, Math.round((colorfulSum / gray.length) * 1.6)));
    const skinRatio = skinLike / gray.length;

    let lapSum = 0;
    let lapSquared = 0;
    let count = 0;
    let centerEdges = 0;
    let borderEdges = 0;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const center = gray[y * width + x] * 4;
        const lap = center
          - gray[y * width + x - 1]
          - gray[y * width + x + 1]
          - gray[(y - 1) * width + x]
          - gray[(y + 1) * width + x];
        lapSum += lap;
        lapSquared += lap * lap;
        count += 1;
        const absLap = Math.abs(lap);
        const inCenter = x > width * 0.22 && x < width * 0.78 && y > height * 0.18 && y < height * 0.82;
        if (inCenter) centerEdges += absLap;
        else borderEdges += absLap;
      }
    }

    const lapMean = lapSum / Math.max(1, count);
    const lapVariance = lapSquared / Math.max(1, count) - lapMean * lapMean;
    const sharpness = Math.max(0, Math.min(100, Math.round(Math.sqrt(Math.max(0, lapVariance)) * 5.2)));
    const contrastScore = Math.max(0, Math.min(100, Math.round(contrast * 2.1)));
    const centerSubject = Math.max(0, Math.min(100, Math.round((centerEdges / Math.max(1, centerEdges + borderEdges)) * 155)));
    const peopleHint = Math.max(0, Math.min(100, Math.round(Math.min(skinRatio, 0.18) / 0.18 * 100)));
    const label = sharpness < 22
      ? "severely_blurry"
      : sharpness < 38
        ? "blurry"
        : sharpness < 55
          ? "soft"
          : "clear";
    return {
      sharpness,
      contrast: contrastScore,
      brightness: brightnessScore,
      entropy: entropyScore,
      colorfulness,
      centerSubject,
      peopleHint,
      skinRatio: Number(skinRatio.toFixed(4)),
      label,
      width: size.width,
      height: size.height
    };
  } catch {
    return { sharpness: 0, contrast: 0, label: "unreadable" };
  }
}

async function readPhotoExif(filePath) {
  let meta = {};
  try {
    meta = await exifr.parse(filePath, {
      tiff: true,
      ifd0: true,
      exif: true,
      gps: true,
      xmp: false,
      iptc: false,
      translateValues: false,
      reviveValues: true
    }) || {};
  } catch {
    meta = {};
  }

  let size = {
    width: Number(meta.ImageWidth || meta.ExifImageWidth || meta.PixelXDimension || meta.SourceImageWidth || 0) || null,
    height: Number(meta.ImageHeight || meta.ExifImageHeight || meta.PixelYDimension || meta.SourceImageHeight || 0) || null
  };
  if (!size.width || !size.height) {
    try {
      const image = nativeImage.createFromPath(filePath);
      if (!image.isEmpty()) size = image.getSize();
    } catch {
      size = { width: null, height: null };
    }
  }

  const make = String(meta.Make || "").trim();
  const model = String(meta.Model || "").trim();
  const lensModel = String(meta.LensModel || meta.Lens || "").trim();
  const camera = [make, model].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const focal = typeof meta.FocalLength === "number" ? `${Math.round(meta.FocalLength)}mm` : "";
  const aperture = typeof meta.FNumber === "number" ? `f/${Number(meta.FNumber).toFixed(1).replace(".0", "")}` : "";
  const exposure = formatExposure(meta.ExposureTime);
  const iso = meta.ISO || meta.ISOSpeedRatings ? `ISO ${meta.ISO || meta.ISOSpeedRatings}` : "";
  const lens = lensModel || [focal, aperture].filter(Boolean).join(" ");
  const settings = [focal, aperture, exposure, iso].filter(Boolean).join("  ");
  const latitude = typeof meta.latitude === "number" ? meta.latitude : meta.GPSLatitude;
  const longitude = typeof meta.longitude === "number" ? meta.longitude : meta.GPSLongitude;

  return {
    camera,
    make,
    model,
    lens,
    lensModel,
    focal,
    aperture,
    exposure,
    iso,
    settings,
    width: size.width,
    height: size.height,
    orientation: size.width && size.height
      ? size.width > size.height ? "landscape" : size.width < size.height ? "portrait" : "square"
      : "",
    location: formatCoordinate(latitude, longitude),
    latitude,
    longitude,
    dateTaken: normalizeExifDate(meta.DateTimeOriginal || meta.CreateDate || meta.ModifyDate || meta.DateTime)
  };
}

async function walkPhotos(folder) {
  const found = [];
  const stack = [folder];
  let visitedFiles = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }

      try {
        visitedFiles += 1;
        if (visitedFiles % 35 === 0) {
          sendWorkflowStatus(`正在扫描照片：已检查 ${visitedFiles} 个文件，本地质检会排除明显模糊的图。`);
          await yieldToEventLoop();
        }
        const stat = fs.statSync(fullPath);
        const dateInfo = parseDateFromName(entry.name, stat);
        const exif = await readPhotoExif(fullPath);
        const finalDate = exif.dateTaken || dateInfo.date;
        const finalConfidence = exif.dateTaken ? "high" : dateInfo.confidence;
        const finalSource = exif.dateTaken ? "exif" : dateInfo.source;
        const id = hashPhoto(fullPath, stat);
        found.push({
          id,
          path: fullPath,
          fileUrl: photoUrl(id, stat.mtimeMs || stat.size),
          name: entry.name,
          folder,
          size: stat.size,
          date: finalDate,
          dateConfidence: finalConfidence,
          dateSource: finalSource,
          exif,
          localQuality: null,
          localScore: localPhotoScores({ exif, size: stat.size, date: finalDate, dateConfidence: finalConfidence }),
          lastModified: stat.mtimeMs,
          favorite: false,
          hidden: false
        });
      } catch {
        continue;
      }
    }
  }

  return found;
}

function dateRelationship(photoDate) {
  const today = new Date();
  const date = new Date(`${photoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return "日期未知";
  }

  const sameMonthDay = date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  if (sameMonthDay && date.getFullYear() < today.getFullYear()) {
    return "那年今日";
  }
  if (date.getMonth() === today.getMonth()) {
    return "同月旧照";
  }
  return "旧时光";
}

function dateDistanceToToday(photoDate) {
  const today = new Date();
  const date = new Date(`${photoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return 366;
  const todayDay = Math.floor((Date.UTC(2000, today.getMonth(), today.getDate()) - Date.UTC(2000, 0, 1)) / 86400000);
  const photoDay = Math.floor((Date.UTC(2000, date.getMonth(), date.getDate()) - Date.UTC(2000, 0, 1)) / 86400000);
  const diff = Math.abs(todayDay - photoDay);
  return Math.min(diff, 366 - diff);
}

function dateProximityBoost(photoDate) {
  const distance = dateDistanceToToday(photoDate);
  if (distance === 0) return 34;
  if (distance <= 1) return 28;
  if (distance <= 3) return 22;
  if (distance <= 7) return 16;
  if (distance <= 15) return 9;
  if (distance <= 31) return 4;
  return 0;
}

function wallpaperResolutionScore(photo) {
  const width = Number(photo.exif?.width || 0);
  const height = Number(photo.exif?.height || 0);
  if (!width || !height) return 28;

  const sourceAspect = width / height;
  const isPortrait = sourceAspect < 0.86;
  const foregroundScale = isPortrait
    ? Math.min((WALLPAPER_TARGET_WIDTH * 0.72) / width, (WALLPAPER_TARGET_HEIGHT * 0.94) / height)
    : Math.max(WALLPAPER_TARGET_WIDTH / width, WALLPAPER_TARGET_HEIGHT / height);
  const pixels = width * height;
  const pixelRatio = pixels / WALLPAPER_TARGET_PIXELS;
  let score = 100;

  if (foregroundScale > 2.2) score = 12;
  else if (foregroundScale > 1.75) score = 24;
  else if (foregroundScale > 1.45) score = 42;
  else if (foregroundScale > 1.22) score = 62;
  else if (foregroundScale > 1.08) score = 78;

  if (pixelRatio < 0.22) score -= 28;
  else if (pixelRatio < 0.38) score -= 18;
  else if (pixelRatio < 0.62) score -= 8;
  else if (pixelRatio >= 1) score += 6;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function localPhotoScores(photo) {
  const width = Number(photo.exif?.width || 0);
  const height = Number(photo.exif?.height || 0);
  const pixels = width * height;
  const resolution = wallpaperResolutionScore(photo);
  const orientation = photo.exif?.orientation || "";
  const aspect = width && height ? Math.max(width, height) / Math.max(1, Math.min(width, height)) : 1;
  const localQuality = photo.localQuality || photo.quality || {};
  const sharpness = Number(localQuality.sharpness || 0);
  const contrast = Number(localQuality.contrast || 0);
  const brightness = Number(localQuality.brightness || 0);
  const entropy = Number(localQuality.entropy || 0);
  const colorfulness = Number(localQuality.colorfulness || 0);
  const centerSubject = Number(localQuality.centerSubject || 0);
  const peopleHint = Number(localQuality.peopleHint || 0);
  let wallpaper = 42;
  let memory = 52;
  let safety = 88;

  wallpaper += Math.round((resolution - 50) * 0.72);
  if (pixels >= WALLPAPER_TARGET_PIXELS) wallpaper += 12;
  else if (pixels >= 6000000) wallpaper += 7;
  else if (pixels >= 3000000) wallpaper += 1;
  else if (pixels >= 1500000) wallpaper -= 10;
  else if (pixels > 0) wallpaper -= 24;

  if (orientation === "landscape") wallpaper += 12;
  if (orientation === "portrait") wallpaper += 6;
  if (aspect > 2.35) wallpaper -= 10;
  if (photo.size > 300000) wallpaper += 6;
  if (sharpness >= 72) wallpaper += 12;
  else if (sharpness >= 55) wallpaper += 6;
  else if (sharpness >= 38) wallpaper -= 10;
  else if (sharpness >= 22) {
    wallpaper -= 28;
    memory -= 12;
    safety = Math.min(safety, 66);
  } else {
    wallpaper -= 46;
    memory -= 20;
    safety = Math.min(safety, 46);
  }
  if (contrast > 0 && contrast < 22) wallpaper -= 10;
  if (brightness > 0 && brightness < 42) {
    wallpaper -= 16;
    safety = Math.min(safety, 70);
  }
  if (entropy > 0 && entropy < 42) {
    wallpaper -= 18;
    memory -= 8;
    safety = Math.min(safety, 68);
  }
  if (centerSubject >= 72) wallpaper += 10;
  else if (centerSubject >= 58) wallpaper += 5;
  else wallpaper -= 6;
  if (colorfulness >= 50) wallpaper += 5;
  if (peopleHint >= 42) {
    memory += 14;
    wallpaper += 4;
  } else if (peopleHint >= 20) {
    memory += 7;
  }
  if (photo.dateConfidence === "high") memory += 10;
  memory += dateProximityBoost(photo.date);

  return {
    memory: Math.max(0, Math.min(100, Math.round(memory))),
    wallpaper: Math.max(0, Math.min(100, Math.round(wallpaper))),
    safety,
    resolution,
    sharpness: Math.max(0, Math.min(100, Math.round(sharpness))),
    contrast: Math.max(0, Math.min(100, Math.round(contrast))),
    brightness: Math.max(0, Math.min(100, Math.round(brightness))),
    entropy: Math.max(0, Math.min(100, Math.round(entropy))),
    peopleHint: Math.max(0, Math.min(100, Math.round(peopleHint)))
  };
}

function getLocalScore(photo) {
  if (!photo.localScore || !Number.isFinite(Number(photo.localScore.resolution))) {
    photo.localScore = localPhotoScores(photo);
  }
  return photo.localScore;
}

function ensureLocalQuality(photo) {
  if (!photo.localQuality || !Number.isFinite(Number(photo.localQuality.sharpness))) {
    photo.localQuality = estimateLocalImageQuality(photo.path);
    photo.localScore = localPhotoScores({
      ...photo,
      localQuality: photo.localQuality
    });
  }
  return photo.localQuality;
}

function combinedPhotoScore(photo) {
  const local = getLocalScore(photo);
  const ai = data.analyses[photo.id]?.score;
  const memory = Number(ai?.memory ?? local.memory);
  const wallpaper = Number(ai?.wallpaper ?? local.wallpaper);
  const safety = Number(ai?.safety ?? local.safety);
  const resolution = Number(local.resolution ?? wallpaperResolutionScore(photo));
  if (safety < 60) return -1;
  return Math.round(wallpaper * 0.44 + memory * 0.27 + safety * 0.12 + resolution * 0.17);
}

function buildStructuredPhotoInput(photo) {
  return {
    task: "caption_and_score",
    schema_version: "1.0",
    photo_id: photo.id,
    shooting_date: photo.date,
    date_confidence: photo.dateConfidence,
    relation_to_today: dateRelationship(photo.date),
    visible_facts: ["用户选择的本地照片", "可作为壁纸候选"],
    exif: {
      camera: photo.exif?.camera || "",
      lens: photo.exif?.lens || "",
      settings: photo.exif?.settings || "",
      location: photo.exif?.location || "",
      dimensions: photo.exif?.width && photo.exif?.height ? `${photo.exif.width}x${photo.exif.height}` : ""
    },
    image_orientation: photo.exif?.orientation || "",
    local_quality: {
      sharpness: photo.localQuality?.sharpness ?? photo.localScore?.sharpness ?? "",
      contrast: photo.localQuality?.contrast ?? "",
      label: photo.localQuality?.label || ""
    },
    caption_style: data.config.captionStyle,
    allow_mention_people: false,
    allow_infer_location: false,
    never_write_about: ["文件名", "文件大小", "未知设备", "未知地点", "日期来源", "屏幕保护程序", "上传状态"],
    forbidden_words: FORBIDDEN_WORDS,
    required_output_schema: {
      score: {
        memory_score: "0-100 number",
        wallpaper_score: "0-100 number",
        safety_score: "0-100 number"
      },
      captions: [
        {
          text: "12-28 个中文字符，最多不超过 40 个中文字符",
          style: "string",
          reason: "string"
        }
      ]
    }
  };
}

function validateCaption(text) {
  if (!text || typeof text !== "string") return false;
  const compact = text.trim();
  if (compact.length < 6 || compact.length > 34) return false;
  const metaLeakWords = [
    "文件", "文件名", "文件大小", "未知", "未记录", "未确认", "日期来源",
    "屏幕保护", "程序", "列表", "相机型号", "设备", "镜头信息", "EXIF"
  ];
  if (metaLeakWords.some((word) => compact.includes(word))) return false;
  return !FORBIDDEN_WORDS.some((word) => compact.includes(word));
}

function captionSignature(text) {
  return String(text || "")
    .replace(/[，。！？、\s]/g, "")
    .replace(/光|风|日子|时间|过去|回来|安静/g, "_")
    .slice(0, 8);
}

function isTooSimilarCaption(a, b) {
  const left = String(a || "").replace(/[，。！？、\s]/g, "");
  const right = String(b || "").replace(/[，。！？、\s]/g, "");
  if (!left || !right) return false;
  if (left.slice(0, 3) === right.slice(0, 3)) return true;
  if (left.slice(-3) === right.slice(-3)) return true;
  return captionSignature(left) === captionSignature(right);
}

function chooseDistinctFallback(usedCaptions, seed = 0) {
  for (let index = 0; index < FALLBACK_CAPTIONS.length; index += 1) {
    const caption = FALLBACK_CAPTIONS[(seed + index) % FALLBACK_CAPTIONS.length];
    if (!usedCaptions.some((used) => isTooSimilarCaption(used, caption))) {
      return caption;
    }
  }
  return FALLBACK_CAPTIONS[seed % FALLBACK_CAPTIONS.length];
}

function normalizeAnalysis(photo, raw, usedCaptions = []) {
  const captions = Array.isArray(raw?.captions)
    ? raw.captions
        .map((item) => ({
          text: String(item.text || "").trim(),
          style: String(item.style || data.config.captionStyle || "克制"),
          reason: String(item.reason || "符合克制、时间感和壁纸短文案要求")
        }))
        .filter((item) => validateCaption(item.text))
        .sort((a, b) => {
          const aCliche = CLICHE_WORDS.some((word) => a.text.includes(word)) ? 1 : 0;
          const bCliche = CLICHE_WORDS.some((word) => b.text.includes(word)) ? 1 : 0;
          return aCliche - bCliche;
        })
        .slice(0, 3)
    : [];

  if (captions[0] && usedCaptions.some((text) => isTooSimilarCaption(text, captions[0].text))) {
    const different = captions.find((item) => !usedCaptions.some((text) => isTooSimilarCaption(text, item.text)));
    if (different) {
      const rest = captions.filter((item) => item !== different);
      captions.splice(0, captions.length, different, ...rest);
    }
  }

  return {
    photoId: photo.id,
    generatedAt: new Date().toISOString(),
    source: raw?.source || "llm_feature_batch",
    error: raw?.error || null,
    score: {
      memory: Number(raw?.score?.memory_score ?? raw?.score?.memory ?? 68),
      wallpaper: Number(raw?.score?.wallpaper_score ?? raw?.score?.wallpaper ?? 72),
      safety: Number(raw?.score?.safety_score ?? raw?.score?.safety ?? 90)
    },
    tags: raw?.tags || [dateRelationship(photo.date), "安静", "旧时光"],
    captions
  };
}

function imageToDataUrl(filePath, maxSide = 1024) {
  const source = nativeImage.createFromPath(filePath);
  if (source.isEmpty()) {
    throw new Error("Image cannot be read.");
  }

  const size = source.getSize();
  const longestSide = Math.max(size.width, size.height);
  const targetSide = Number(maxSide || 1024);
  const scale = longestSide > targetSide ? targetSide / longestSide : 1;
  const resized = scale < 1
    ? source.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: "good"
      })
    : source;

  return resized.toDataURL();
}

function buildChatEndpoint(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/$/, "");
  if (normalized.endsWith("/messages")) return normalized;
  if (normalized.endsWith("/chat/completions")) return normalized;
  return `${normalized}/chat/completions`;
}

function buildEndpoint(baseUrl, protocolName) {
  const normalized = String(baseUrl || "").trim().replace(/\/$/, "");
  if (protocolName === "anthropic") {
    if (normalized.endsWith("/messages")) return normalized;
    return `${normalized}/messages`;
  }
  return buildChatEndpoint(normalized);
}

function canonicalModelForProvider(model, baseUrl = "") {
  const value = String(model || "").trim();
  const isXiaomi = String(baseUrl || "").toLowerCase().includes("xiaomimimo");
  const lower = value.toLowerCase();
  if (isXiaomi && lower.startsWith("mimo-v")) return lower;
  return value;
}

function supportsVisionMessages(config) {
  if ((config.privacyMode || "feature_only") !== "visual_opt_in") return false;
  const baseUrl = String(config.baseUrl || "").toLowerCase();
  const model = canonicalModelForProvider(config.model, config.baseUrl).toLowerCase();
  if (baseUrl.includes("xiaomimimo")) {
    return ["mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-omni"].includes(model);
  }
  return true;
}

function assertVisionCaptionReady(config) {
  if ((config.privacyMode || "feature_only") !== "visual_opt_in") {
    throw new Error("旧日来信需要让模型读取图片。请在 LLM 设置里选择 visual opt-in。");
  }

  if (!supportsVisionMessages(config)) {
    const model = canonicalModelForProvider(config.model, config.baseUrl);
    throw new Error(`当前模型 ${model} 未确认为可读图模型，不能为照片生成可靠文案。小米 MiMo 可使用 mimo-v2.5 或 mimo-v2-omni。`);
  }
}

function modelAliasCandidates(model, baseUrl = "") {
  const value = String(model || "").trim();
  const canonical = canonicalModelForProvider(value, baseUrl);
  const lower = value.toLowerCase();
  const aliases = [canonical];
  if (value && value !== canonical) aliases.push(value);

  if (lower === "mimo-v2.5") {
    aliases.push("mimo-v2.5", "xiaomi/mimo-v2.5", "MiMo-V2.5-Pro", "mimo-v2.5-pro", "xiaomi/mimo-v2.5-pro");
  } else if (lower === "mimo-v2.5-pro") {
    aliases.push("mimo-v2.5-pro", "xiaomi/mimo-v2.5-pro", "MiMo-V2.5", "mimo-v2.5", "xiaomi/mimo-v2.5");
  }

  return Array.from(new Set(aliases.filter(Boolean)));
}

function isUnsupportedModelError(error) {
  return /not supported model|model.+not.*support|unsupported model|model_not_found|not found/i.test(String(error?.message || ""));
}

function parseJsonContent(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error("LLM response did not contain content.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("LLM response is not JSON.");
    return JSON.parse(match[0]);
  }
}

function normalizeMessagesForAnthropic(messages) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
    .join("\n\n");

  const anthropicMessages = messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (Array.isArray(message.content)) {
        return {
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content.map((part) => {
            if (part.type === "text") return { type: "text", text: part.text };
            if (part.type === "image_url") {
              const match = String(part.image_url?.url || "").match(/^data:(.+?);base64,(.+)$/);
              if (!match) return { type: "text", text: "[image omitted]" };
              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: match[1],
                  data: match[2]
                }
              };
            }
            return { type: "text", text: JSON.stringify(part) };
          })
        };
      }

      return {
        role: message.role === "assistant" ? "assistant" : "user",
        content: String(message.content || "")
      };
    });

  return { system, messages: anthropicMessages };
}

async function postChatCompletion(endpoint, config, messages, useResponseFormat) {
  const protocol = config.protocol || "openai";
  let body;
  let headers = {
    "Content-Type": "application/json"
  };

  if (protocol === "anthropic") {
    const normalized = normalizeMessagesForAnthropic(messages);
    body = {
      model: config.model,
      max_tokens: 4096,
      temperature: 0.55,
      system: normalized.system,
      messages: normalized.messages
    };
    headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    body = {
      model: config.model,
      temperature: 0.55,
      messages
    };

    if (useResponseFormat) {
      body.response_format = { type: "json_object" };
    }

    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(config.timeoutMs || DEFAULT_CONFIG.timeoutMs));

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`LLM request timed out after ${config.timeoutMs || DEFAULT_CONFIG.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`LLM request failed: ${response.status} ${detail.slice(0, 300)}`);
  }

  const responseText = await response.text();
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    const contentType = response.headers.get("content-type") || "unknown";
    const looksLikeHtml = responseText.trim().startsWith("<");
    const hint = looksLikeHtml
      ? "接口返回了网页 HTML，不是 JSON。Base URL 很可能填成了中转商网页地址，通常需要以 /v1 结尾。"
      : "接口没有返回合法 JSON。";
    throw new Error(`${hint} endpoint=${endpoint}, content-type=${contentType}`);
  }
  if (protocol === "anthropic") {
    const text = Array.isArray(payload.content)
      ? payload.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
      : "";
    return { choices: [{ message: { content: text } }], raw: payload };
  }
  return payload;
}

async function postChatCompletionWithModelFallback(endpoint, config, messages, useResponseFormat) {
  const candidates = modelAliasCandidates(config.model, config.baseUrl);
  let lastError;

  for (const model of candidates) {
    try {
      return await postChatCompletion(endpoint, { ...config, model }, messages, useResponseFormat);
    } catch (error) {
      lastError = error;
      if (!isUnsupportedModelError(error)) throw error;
    }
  }

  throw lastError;
}

async function callOpenAICompatible(photo) {
  const config = data.config;
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new Error("LLM configuration is incomplete.");
  }
  assertVisionCaptionReady(config);

  const endpoint = buildEndpoint(config.baseUrl, config.protocol || "openai");
  const structuredInput = buildStructuredPhotoInput(photo);
  const textPrompt = `请根据以下照片信息生成壁纸短文案和打分。必须返回严格 JSON，格式为：
{
  "score": {
    "memory_score": 0,
    "wallpaper_score": 0,
    "safety_score": 0
  },
  "tags": ["标签"],
  "captions": [
    {
      "text": "文案内容",
      "style": "克制",
      "reason": "为什么适合这张照片"
    }
  ]
}

照片信息：
${JSON.stringify(structuredInput, null, 2)}`;

  let userContent = textPrompt;

  const sentVisualInput = supportsVisionMessages(config);

  if (sentVisualInput) {
    userContent = [
      { type: "text", text: textPrompt },
      {
        type: "image_url",
        image_url: { url: imageToDataUrl(photo.path) }
      }
    ];
  }

  const messages = [
    { role: "system", content: CAPTION_SYSTEM_PROMPT },
    { role: "user", content: userContent }
  ];

  let payload;
  try {
    payload = await postChatCompletionWithModelFallback(endpoint, config, messages, true);
  } catch (error) {
    if (!String(error.message).includes("response_format")) throw error;
    payload = await postChatCompletionWithModelFallback(endpoint, config, messages, false);
  }

  const text = payload?.choices?.[0]?.message?.content;
  return { ...parseJsonContent(text), source: sentVisualInput ? "llm_visual" : "llm_feature_only" };
}

function normalizeModelScore(raw) {
  const score = raw?.score || raw || {};
  const memory = Number(score.memory_score ?? score.memory ?? 0);
  const wallpaper = Number(score.wallpaper_score ?? score.wallpaper ?? 0);
  const safety = Number(score.safety_score ?? score.safety ?? 0);
  return {
    memory: Math.max(0, Math.min(100, Math.round(Number.isFinite(memory) ? memory : 0))),
    wallpaper: Math.max(0, Math.min(100, Math.round(Number.isFinite(wallpaper) ? wallpaper : 0))),
    safety: Math.max(0, Math.min(100, Math.round(Number.isFinite(safety) ? safety : 0)))
  };
}

function hasModelScore(photoId) {
  const score = data.analyses[photoId]?.score;
  return Number.isFinite(Number(score?.memory))
    && Number.isFinite(Number(score?.wallpaper))
    && Number.isFinite(Number(score?.safety));
}

async function callOpenAICompatibleScore(photo) {
  const config = data.config;
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new Error("LLM configuration is incomplete.");
  }
  assertVisionCaptionReady(config);

  const endpoint = buildEndpoint(config.baseUrl, config.protocol || "openai");
  const structuredInput = buildStructuredPhotoInput(photo);
  const textPrompt = `请只为这张照片打分，不要生成文案。必须根据图片视觉质量判断是否适合进入「旧日来信」。

重点看：清晰度、失焦/手抖、曝光、主体可读性、构图、桌面壁纸适配度、回忆感、隐私和安全风险。
模糊、失焦、遮挡严重、构图杂乱、截图/文件/票据/纯文字、非常不适合壁纸的照片必须给低分。

返回严格 JSON：
{
  "score": {
    "memory_score": 0,
    "wallpaper_score": 0,
    "safety_score": 0
  },
  "quality_flags": ["清晰/轻微模糊/严重模糊/构图杂乱/适合壁纸等"],
  "reason": "一句话说明"
}

照片信息：
${JSON.stringify(structuredInput, null, 2)}`;

  const userContent = [
    { type: "text", text: textPrompt },
    {
      type: "image_url",
      image_url: { url: imageToDataUrl(photo.path, 640) }
    }
  ];

  const messages = [
    { role: "system", content: SCORE_SYSTEM_PROMPT },
    { role: "user", content: userContent }
  ];

  let payload;
  try {
    payload = await postChatCompletionWithModelFallback(endpoint, config, messages, true);
  } catch (error) {
    if (!String(error.message).includes("response_format")) throw error;
    payload = await postChatCompletionWithModelFallback(endpoint, config, messages, false);
  }

  const text = payload?.choices?.[0]?.message?.content;
  return parseJsonContent(text);
}

function buildBatchPhotoInput(photos) {
  return photos.map((photo, index) => ({
    index: index + 1,
    photo_id: photo.id,
    shooting_date: photo.date,
    date_confidence: photo.dateConfidence,
    relation_to_today: dateRelationship(photo.date),
    visible_facts: ["用户选择的本地照片", "壁纸候选"],
    exif: {
      camera: photo.exif?.camera || "",
      lens: photo.exif?.lens || "",
      settings: photo.exif?.settings || "",
      location: photo.exif?.location || "",
      dimensions: photo.exif?.width && photo.exif?.height ? `${photo.exif.width}x${photo.exif.height}` : ""
    },
    image_orientation: photo.exif?.orientation || "",
    local_quality: {
      sharpness: photo.localQuality?.sharpness ?? "",
      contrast: photo.localQuality?.contrast ?? "",
      label: photo.localQuality?.label || ""
    },
    allow_mention_people: false,
    allow_infer_location: false,
    never_write_about: ["文件名", "文件大小", "未知设备", "未知地点", "日期来源", "屏幕保护程序", "上传状态"]
  }));
}

async function callOpenAICompatibleBatch(photos) {
  const config = data.config;
  if (!config.baseUrl || !config.apiKey || !config.model) {
    throw new Error("LLM configuration is incomplete.");
  }
  assertVisionCaptionReady(config);

  const endpoint = buildEndpoint(config.baseUrl, config.protocol || "openai");
  const photoInputs = buildBatchPhotoInput(photos);
  const textPrompt = `请为以下 ${photos.length} 张旧照片生成壁纸文案和内部打分。

重要：
1. 必须为每一个 photo_id 返回一个 item，不能只返回 3 条文案。
2. 每个 item 里 captions 必须有 3 条候选，其中第 1 条是主文案。
3. 所有主文案之间必须避开相似句式、相似开头、相似结尾和重复意象。
4. 必须结合紧随其后的图片视觉内容写文案，不要只根据日期或 EXIF 猜。
5. 严禁写文件名、文件大小、日期来源、未知设备、未知地点、屏幕保护程序、列表顺序等元信息。
6. 可以说“光、下午、安静、靠近、抬头、停顿”等视觉可见或氛围词，但不得编造人物关系、地点、事件。

输出严格 JSON：
{
  "items": [
    {
      "photo_id": "原 photo_id",
      "score": {
        "memory_score": 0,
        "wallpaper_score": 0,
        "safety_score": 0
      },
      "tags": ["标签"],
      "captions": [
        {
          "text": "主文案",
          "style": "克制",
          "reason": "为什么适合"
        },
        {
          "text": "备选文案",
          "style": "克制",
          "reason": "为什么适合"
        },
        {
          "text": "备选文案",
          "style": "克制",
          "reason": "为什么适合"
        }
      ]
    }
  ]
}

照片列表：
${JSON.stringify(photoInputs, null, 2)}`;

  let userContent = textPrompt;
  const sentVisualInput = supportsVisionMessages(config);

  if (sentVisualInput) {
    userContent = [{ type: "text", text: textPrompt }];
    for (const [index, photo] of photos.entries()) {
      userContent.push({ type: "text", text: `图片 ${index + 1}，photo_id=${photo.id}` });
      userContent.push({
        type: "image_url",
        image_url: { url: imageToDataUrl(photo.path) }
      });
    }
  }

  const messages = [
    { role: "system", content: BATCH_CAPTION_SYSTEM_PROMPT },
    { role: "user", content: userContent }
  ];

  let payload;
  try {
    payload = await postChatCompletionWithModelFallback(endpoint, config, messages, true);
  } catch (error) {
    if (!String(error.message).includes("response_format")) throw error;
    payload = await postChatCompletionWithModelFallback(endpoint, config, messages, false);
  }

  const content = payload?.choices?.[0]?.message?.content;
  const parsed = parseJsonContent(content);
  const items = Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed) ? parsed : [];
  if (items.length === 0) {
    throw new Error("LLM batch response did not contain items.");
  }

  return items.map((item) => ({
    ...item,
    source: sentVisualInput ? "llm_visual_batch" : "llm_feature_batch"
  }));
}

function localCandidateScore(photo) {
  const local = getLocalScore(photo);
  if (Number(local.safety) < 60) return -1;
  const todayBoost = dateProximityBoost(photo.date);
  return Math.round(
    local.wallpaper * 0.34
    + local.memory * 0.24
    + local.safety * 0.12
    + Number(local.resolution ?? wallpaperResolutionScore(photo)) * 0.18
    + Number(local.sharpness || 0) * 0.06
    + Number(local.peopleHint || 0) * 0.06
    + todayBoost * 1.4
  );
}

function selectDateProximityPool(source, minimum, options = {}) {
  const preferResolution = options.preferResolution !== false;
  const visible = source.filter((photo) => !photo.hidden);
  let fallback = visible;
  for (const windowDays of [0, 1, 3, 7, 15, 31, 366]) {
    const pool = visible.filter((photo) => dateDistanceToToday(photo.date) <= windowDays);
    if (pool.length < minimum && windowDays !== 366) continue;
    if (!preferResolution) return pool;

    const highResolution = pool.filter((photo) => Number(getLocalScore(photo).resolution || 0) >= 62);
    if (highResolution.length >= minimum) return highResolution;

    const usableResolution = pool.filter((photo) => Number(getLocalScore(photo).resolution || 0) >= 42);
    if (usableResolution.length >= minimum) return usableResolution;

    fallback = pool;
    if (windowDays === 366) return usableResolution.length > 0 ? usableResolution : highResolution.length > 0 ? highResolution : fallback;
  }
  return visible;
}

function preferHighResolutionPool(photos, limit) {
  for (const threshold of [62, 42]) {
    const qualified = photos.filter((photo) => Number(getLocalScore(photo).resolution || 0) >= threshold);
    if (qualified.length >= limit) return qualified;
  }
  return photos;
}

function selectScoreCandidates(limit, options = {}) {
  const useQualityCheck = Boolean(options.useQualityCheck);
  const source = Array.isArray(options.source) ? options.source : data.photos;
  const datePool = selectDateProximityPool(source, Math.min(limit, source.length));
  const roughLimit = Math.min(datePool.length, Math.max(limit * 4, 80));
  const roughCandidates = datePool
    .filter((photo) => !photo.hidden)
    .filter((photo) => getLocalScore(photo).safety >= 60)
    .sort((a, b) => {
      const aScore = localCandidateScore(a);
      const bScore = localCandidateScore(b);
      if (aScore !== bScore) return bScore - aScore;
      return b.lastModified - a.lastModified;
    })
    .slice(0, roughLimit);

  if (useQualityCheck) {
    for (const photo of roughCandidates) {
      ensureLocalQuality(photo);
    }
    saveData();
  }

  const qualityCandidates = roughCandidates
    .filter((photo) => {
      if (!useQualityCheck) return true;
      return Number((photo.localQuality || {}).sharpness ?? (photo.localScore || {}).sharpness ?? 0) >= 22;
    });
  return preferHighResolutionPool(qualityCandidates, limit)
    .sort((a, b) => {
      const aScore = localCandidateScore(a);
      const bScore = localCandidateScore(b);
      if (aScore !== bScore) return bScore - aScore;
      return b.lastModified - a.lastModified;
    })
    .slice(0, limit);
}

function clearGeneratedCaptions(photoId) {
  const existing = data.analyses[photoId];
  if (existing?.score) {
    data.analyses[photoId] = {
      photoId,
      generatedAt: existing.generatedAt || new Date().toISOString(),
      source: existing.source || "llm_visual_score",
      score: existing.score,
      tags: existing.tags || [],
      captions: []
    };
  } else {
    delete data.analyses[photoId];
  }
}

async function scorePhotosForSelection(photos, options = {}) {
  const force = Boolean(options.force);
  const targets = photos.filter((photo) => force || !hasModelScore(photo.id));
  if (targets.length === 0) return [];

  const results = [];
  for (const [index, photo] of targets.entries()) {
    sendWorkflowStatus(`正在打分中：${index + 1} / ${targets.length}。模型会先淘汰模糊和不适合做壁纸的照片。`);
    const raw = await callOpenAICompatibleScore(photo);
    const score = normalizeModelScore(raw);
    const existing = data.analyses[photo.id] || {};
    data.analyses[photo.id] = {
      ...existing,
      photoId: photo.id,
      generatedAt: new Date().toISOString(),
      source: existing.captions?.[0]?.text ? existing.source || "llm_visual" : "llm_visual_score",
      score,
      scoreReason: String(raw?.reason || ""),
      qualityFlags: Array.isArray(raw?.quality_flags) ? raw.quality_flags : []
    };
    results.push(data.analyses[photo.id]);
    saveData();
  }
  return results;
}

async function prepareDailyLetter(options = {}) {
  const force = Boolean(options.force);
  const scoreAll = Boolean(options.scoreAll);
  if (force) {
    data.analyses = {};
    saveData();
  }
  const dailyLimit = Number(data.config.dailyLimit || 10);
  const configuredCandidateLimit = Number(data.config.candidateLimit || DEFAULT_CONFIG.candidateLimit);
  const candidateLimit = scoreAll
    ? data.photos.length
    : Math.min(
        Math.max(dailyLimit * 2, Number.isFinite(configuredCandidateLimit) ? configuredCandidateLimit : DEFAULT_CONFIG.candidateLimit),
        40,
        data.photos.length
      );
  const candidates = selectScoreCandidates(candidateLimit, { useQualityCheck: true });
  if (candidates.length === 0) return { dailyTen: [], analyses: [] };

  assertVisionCaptionReady(data.config);
  sendWorkflowStatus(`正在打分中：已送入 ${candidates.length} 张候选照片，先选出更适合做壁纸的十张。`);
  await scorePhotosForSelection(candidates, { force });

  const selected = selectDailyTen().slice(0, dailyLimit);
  sendWorkflowStatus(`已选出 ${selected.length} 张高分照片，正在生成旧日来信文案。`);
  const analyses = await analyzePhotosBatch(selected.map((photo) => photo.id), { force });
  sendWorkflowStatus("今日十张已完成：模型评分和文案都准备好了。");
  return {
    dailyTen: publicPhotos(selectDailyTen()),
    analyses
  };
}

async function analyzePhotosBatch(photoIds, options = {}) {
  const force = Boolean(options.force);
  const photos = photoIds
    .map((id) => data.photos.find((item) => item.id === id))
    .filter(Boolean)
    .filter((photo) => force || !data.analyses[photo.id] || !data.analyses[photo.id]?.captions?.[0]?.text);

  if (photos.length === 0) {
    return photoIds.map((id) => data.analyses[id]).filter(Boolean);
  }

  if (force) {
    for (const photo of photos) {
      clearGeneratedCaptions(photo.id);
    }
    saveData();
  }

  if (supportsVisionMessages(data.config)) {
    const usedCaptions = [];
    const results = [];
    for (const photo of photos) {
      sendWorkflowStatus(`正在生成文案：${results.length + 1} / ${photos.length}。只为模型选出的高分照片写文案。`);
      const raw = await callOpenAICompatible(photo);
      const analysis = normalizeAnalysis(photo, raw, usedCaptions);
      if (!analysis.captions[0]?.text) {
        throw new Error(`第 ${results.length + 1} 张照片没有通过文案校验，请重新生成。`);
      }
      usedCaptions.push(analysis.captions[0].text);
      data.analyses[photo.id] = analysis;
      results.push(analysis);
      saveData();
    }
    return results;
  }

  let rawItems = [];
  try {
    rawItems = await callOpenAICompatibleBatch(photos);
  } catch (error) {
    throw new Error(`LLM 文案生成失败：${error.message}`);
  }

  const rawById = new Map(rawItems.map((item) => [item.photo_id || item.photoId || item.id, item]));
  const usedCaptions = [];
  const results = [];

  for (const photo of photos) {
    sendWorkflowStatus(`正在生成文案：${results.length + 1} / ${photos.length}。只为模型选出的高分照片写文案。`);
    const raw = rawById.get(photo.id);
    if (!raw) {
      throw new Error(`LLM 没有返回第 ${results.length + 1} 张照片的文案。`);
    }
    const analysis = normalizeAnalysis(photo, raw, usedCaptions);
    if (!analysis.captions[0]?.text) {
      throw new Error(`第 ${results.length + 1} 张照片没有通过文案校验，请重新生成。`);
    }
    usedCaptions.push(analysis.captions[0]?.text || "");
    data.analyses[photo.id] = analysis;
    results.push(analysis);
  }

  saveData();
  return results;
}

async function analyzePhoto(photoId) {
  const photo = data.photos.find((item) => item.id === photoId);
  if (!photo) throw new Error("Photo not found.");

  const raw = await callOpenAICompatible(photo);
  const analysis = normalizeAnalysis(photo, raw);
  if (!analysis.captions[0]?.text) {
    throw new Error("LLM 返回的文案没有通过校验。");
  }
  data.analyses[photo.id] = analysis;
  saveData();
  return analysis;
}

function selectDailyTen() {
  const visible = data.photos.filter((photo) => !photo.hidden);
  const dailyLimit = Number(data.config.dailyLimit || 10);
  const datePool = selectDateProximityPool(visible, Math.min(dailyLimit, visible.length));
  const modelScored = datePool.filter((photo) => hasModelScore(photo.id) && data.analyses[photo.id]?.source !== "llm_visual_score");
  const pool = modelScored.length >= dailyLimit ? modelScored : selectScoreCandidates(dailyLimit, { source: datePool });
  const finalPool = pool.length >= dailyLimit ? pool : visible;

  return finalPool
    .sort((a, b) => {
      const aToday = dateRelationship(a.date) === "那年今日" ? 1 : 0;
      const bToday = dateRelationship(b.date) === "那年今日" ? 1 : 0;
      const aScore = combinedPhotoScore(a);
      const bScore = combinedPhotoScore(b);
      if (aToday !== bToday && Math.abs(aScore - bScore) < 18) return bToday - aToday;
      if (aScore !== bScore) return bScore - aScore;
      return b.lastModified - a.lastModified;
    })
    .slice(0, dailyLimit);
}

function runPowerShell(args) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

function wallpaperCacheDir() {
  return path.join(app.getPath("userData"), "wallpaper-cache");
}

function cycleWallpaperCachePath() {
  return path.join(wallpaperCacheDir(), "primary-screen-wallpaper.jpg");
}

function nextWallpaperCachePath() {
  return path.join(wallpaperCacheDir(), `primary-${Date.now()}-${Math.round(Math.random() * 100000)}.jpg`);
}

function cleanupWallpaperCache(keepPath) {
  try {
    const dir = wallpaperCacheDir();
    const keep = path.resolve(keepPath || "").toLowerCase();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".jpg")) continue;
      const fullPath = path.resolve(dir, entry.name);
      if (fullPath.toLowerCase() !== keep) fs.rmSync(fullPath, { force: true });
    }
  } catch {
    // Cache cleanup is best-effort.
  }
}

function defaultWindowsWallpaperPath() {
  const candidates = [
    path.join(process.env.SystemRoot || "C:\\Windows", "Web", "Wallpaper", "Windows", "img0.jpg"),
    path.join(process.env.SystemRoot || "C:\\Windows", "Web", "4K", "Wallpaper", "Windows", "img0_3840x2160.jpg")
  ];
  return candidates.find((item) => fs.existsSync(item)) || "";
}

function desktopWallpaperInteropPowerShell() {
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public enum DESKTOP_WALLPAPER_POSITION {
  Center = 0,
  Tile = 1,
  Stretch = 2,
  Fit = 3,
  Fill = 4,
  Span = 5
}

[StructLayout(LayoutKind.Sequential)]
public struct RECT {
  public int left;
  public int top;
  public int right;
  public int bottom;
}

[ComImport, Guid("C2CF3110-460E-4FC1-B9D0-8A1C0C9CC4BD")]
public class DesktopWallpaper {}

[ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDesktopWallpaper {
  void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
  [return: MarshalAs(UnmanagedType.LPWStr)] string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
  [return: MarshalAs(UnmanagedType.LPWStr)] string GetMonitorDevicePathAt(uint monitorIndex);
  uint GetMonitorDevicePathCount();
  void GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID, out RECT displayRect);
  void SetBackgroundColor(uint color);
  uint GetBackgroundColor();
  void SetPosition(DESKTOP_WALLPAPER_POSITION position);
  DESKTOP_WALLPAPER_POSITION GetPosition();
  void SetSlideshow(IntPtr items);
  IntPtr GetSlideshow();
  void SetSlideshowOptions(uint options, uint slideshowTick);
  void GetSlideshowOptions(out uint options, out uint slideshowTick);
  void AdvanceSlideshow([MarshalAs(UnmanagedType.LPWStr)] string monitorID, uint direction);
  uint GetStatus();
  bool Enable(bool enable);
}

public static class DesktopWallpaperTools {
  private const int ENUM_CURRENT_SETTINGS = -1;

  [DllImport("shcore.dll")]
  private static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);

  [DllImport("user32.dll")]
  private static extern IntPtr MonitorFromPoint(POINT pt, uint flags);

  [DllImport("user32.dll", CharSet = CharSet.Ansi)]
  private static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);

  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int x;
    public int y;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string dmDeviceName;
    public ushort dmSpecVersion;
    public ushort dmDriverVersion;
    public ushort dmSize;
    public ushort dmDriverExtra;
    public uint dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public uint dmDisplayOrientation;
    public uint dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string dmFormName;
    public ushort dmLogPixels;
    public uint dmBitsPerPel;
    public uint dmPelsWidth;
    public uint dmPelsHeight;
    public uint dmDisplayFlags;
    public uint dmDisplayFrequency;
    public uint dmICMMethod;
    public uint dmICMIntent;
    public uint dmMediaType;
    public uint dmDitherType;
    public uint dmReserved1;
    public uint dmReserved2;
    public uint dmPanningWidth;
    public uint dmPanningHeight;
  }

  public static string FindMonitorId(int left, int top, int right, int bottom) {
    IDesktopWallpaper wallpaper = (IDesktopWallpaper)new DesktopWallpaper();
    uint count = wallpaper.GetMonitorDevicePathCount();
    string fallback = null;
    int bestOverlap = -1;
    for (uint i = 0; i < count; i++) {
      string id = wallpaper.GetMonitorDevicePathAt(i);
      RECT rect;
      wallpaper.GetMonitorRECT(id, out rect);
      if (rect.left == left && rect.top == top && rect.right == right && rect.bottom == bottom) return id;
      int overlapLeft = Math.Max(left, rect.left);
      int overlapTop = Math.Max(top, rect.top);
      int overlapRight = Math.Min(right, rect.right);
      int overlapBottom = Math.Min(bottom, rect.bottom);
      int overlap = Math.Max(0, overlapRight - overlapLeft) * Math.Max(0, overlapBottom - overlapTop);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        fallback = id;
      }
    }
    if (fallback != null) return fallback;
    throw new Exception("Cannot find primary monitor id.");
  }

  public static int[] GetPhysicalSizeFromBounds(int left, int top, int width, int height) {
    POINT pt;
    pt.x = left + Math.Max(1, width / 2);
    pt.y = top + Math.Max(1, height / 2);
    IntPtr monitor = MonitorFromPoint(pt, 2);
    uint dpiX = 96;
    uint dpiY = 96;
    try {
      GetDpiForMonitor(monitor, 0, out dpiX, out dpiY);
    } catch {
      dpiX = 96;
      dpiY = 96;
    }
    int physicalWidth = Math.Max(1, (int)Math.Round(width * dpiX / 96.0));
    int physicalHeight = Math.Max(1, (int)Math.Round(height * dpiY / 96.0));
    return new int[] { physicalWidth, physicalHeight };
  }

  public static int[] GetPhysicalSizeForDevice(string deviceName, int left, int top, int width, int height) {
    DEVMODE mode = new DEVMODE();
    mode.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
    if (!String.IsNullOrWhiteSpace(deviceName) && EnumDisplaySettings(deviceName, ENUM_CURRENT_SETTINGS, ref mode)) {
      if (mode.dmPelsWidth > 0 && mode.dmPelsHeight > 0) {
        return new int[] { (int)mode.dmPelsWidth, (int)mode.dmPelsHeight };
      }
    }
    return GetPhysicalSizeFromBounds(left, top, width, height);
  }

  public static string GetWallpaper(string monitorId) {
    IDesktopWallpaper wallpaper = (IDesktopWallpaper)new DesktopWallpaper();
    return wallpaper.GetWallpaper(monitorId);
  }

  public static uint GetMonitorCount() {
    IDesktopWallpaper wallpaper = (IDesktopWallpaper)new DesktopWallpaper();
    return wallpaper.GetMonitorDevicePathCount();
  }

  public static string GetMonitorIdAt(uint index) {
    IDesktopWallpaper wallpaper = (IDesktopWallpaper)new DesktopWallpaper();
    return wallpaper.GetMonitorDevicePathAt(index);
  }

  public static void SetWallpaper(string monitorId, string path) {
    IDesktopWallpaper wallpaper = (IDesktopWallpaper)new DesktopWallpaper();
    wallpaper.SetWallpaper(monitorId, path);
  }

  public static void SetPositionFill() {
    IDesktopWallpaper wallpaper = (IDesktopWallpaper)new DesktopWallpaper();
    wallpaper.SetPosition(DESKTOP_WALLPAPER_POSITION.Fill);
  }
}
"@
`;
}

async function readDesktopWallpaperSettings() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
${desktopWallpaperInteropPowerShell()}
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$monitorId = [DesktopWallpaperTools]::FindMonitorId($screen.Left, $screen.Top, $screen.Right, $screen.Bottom)
$primaryWallpaper = [DesktopWallpaperTools]::GetWallpaper($monitorId)
$monitors = @()
$count = [DesktopWallpaperTools]::GetMonitorCount()
for ($i = 0; $i -lt $count; $i++) {
  $id = [DesktopWallpaperTools]::GetMonitorIdAt([uint32]$i)
  $monitors += [pscustomobject]@{
    monitorId = [string]$id
    wallpaper = [string][DesktopWallpaperTools]::GetWallpaper($id)
  }
}
[pscustomobject]@{
  wallpaper = [string]$primaryWallpaper
  wallpaperStyle = "10"
  tileWallpaper = "0"
  wallpapers = $monitors
} | ConvertTo-Json -Compress
`;
  const output = await runPowerShell(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
  return JSON.parse(output.trim() || "{}");
}

async function restoreDesktopWallpaper(settings = {}) {
  const target = settings.wallpaper || defaultWindowsWallpaperPath();
  if (!target) throw new Error("没有可恢复的默认壁纸。");
  let wallpapers = [];
  if (Array.isArray(settings.wallpapers)) {
    wallpapers = settings.wallpapers;
  } else if (typeof settings.wallpapers === "string" && settings.wallpapers.trim()) {
    try {
      wallpapers = JSON.parse(settings.wallpapers);
    } catch {
      wallpapers = [];
    }
  }
  const restorePath = path.join(app.getPath("userData"), "wallpaper-cache", "restore-wallpapers.json");
  fs.mkdirSync(path.dirname(restorePath), { recursive: true });
  fs.writeFileSync(restorePath, JSON.stringify({
    defaultWallpaper: target,
    wallpapers
  }), "utf8");
  const safeRestorePath = restorePath.replace(/'/g, "''");
  const style = String(settings.wallpaperStyle || "10").replace(/'/g, "''");
  const tile = String(settings.tileWallpaper || "0").replace(/'/g, "''");
  const script = `
$restorePath = '${safeRestorePath}'
$restore = Get-Content -Path $restorePath -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
${desktopWallpaperInteropPowerShell()}
Set-ItemProperty -Path "HKCU:\\Control Panel\\Desktop" -Name WallpaperStyle -Value '${style}'
Set-ItemProperty -Path "HKCU:\\Control Panel\\Desktop" -Name TileWallpaper -Value '${tile}'
[DesktopWallpaperTools]::SetPositionFill()
if ($restore.wallpapers -and $restore.wallpapers.Count -gt 0) {
  foreach ($item in $restore.wallpapers) {
    $path = [string]$item.wallpaper
    if ([string]::IsNullOrWhiteSpace($path)) { $path = [string]$restore.defaultWallpaper }
    [DesktopWallpaperTools]::SetWallpaper([string]$item.monitorId, $path)
  }
} else {
  $count = [DesktopWallpaperTools]::GetMonitorCount()
  for ($i = 0; $i -lt $count; $i++) {
    $id = [DesktopWallpaperTools]::GetMonitorIdAt([uint32]$i)
    [DesktopWallpaperTools]::SetWallpaper($id, [string]$restore.defaultWallpaper)
  }
}
`;
  await runPowerShell(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
}

function wallpaperCaptionForPhoto(photo) {
  if (!photo?.id) return "";
  return String(data.analyses?.[photo.id]?.captions?.[0]?.text || "").trim();
}

function wallpaperPayloadForPhoto(photo) {
  return {
    caption: wallpaperCaptionForPhoto(photo),
    date: photo?.date || "",
    dateSource: photo?.dateSource || photo?.exif?.dateSource || ""
  };
}

async function setWindowsWallpaper(photoPath, payload = {}) {
  const safePath = String(photoPath || "").replace(/'/g, "''");
  const cacheDir = wallpaperCacheDir();
  fs.mkdirSync(cacheDir, { recursive: true });
  const outputPath = nextWallpaperCachePath();
  const payloadPath = path.join(cacheDir, `payload-${Date.now()}-${Math.round(Math.random() * 10000)}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify(payload || {}), "utf8");
  const safeOutputPath = outputPath.replace(/'/g, "''");
  const safePayloadPath = payloadPath.replace(/'/g, "''");
  const script = `
$wallpaperPath = '${safePath}'
$outputPath = '${safeOutputPath}'
$payloadPath = '${safePayloadPath}'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
${desktopWallpaperInteropPowerShell()}

function Get-WrappedTextLines($graphics, $text, $font, $maxWidth, $maxLines) {
  $lines = New-Object System.Collections.Generic.List[string]
  $buffer = ""
  foreach ($char in $text.ToCharArray()) {
    $candidate = "$buffer$char"
    if ($graphics.MeasureString($candidate, $font).Width -le $maxWidth -or $buffer.Length -eq 0) {
      $buffer = $candidate
    } else {
      $lines.Add($buffer)
      $buffer = [string]$char
      if ($lines.Count -ge ($maxLines - 1)) {
        continue
      }
    }
  }
  if ($buffer.Trim().Length -gt 0) {
    $lines.Add($buffer)
  }
  while ($lines.Count -gt $maxLines) {
    $lines.RemoveAt($lines.Count - 1)
  }
  return $lines
}

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$screenInfo = [System.Windows.Forms.Screen]::PrimaryScreen
$physicalSize = [DesktopWallpaperTools]::GetPhysicalSizeForDevice($screenInfo.DeviceName, $screen.Left, $screen.Top, $screen.Width, $screen.Height)
$payload = Get-Content -Path $payloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
$caption = [string]$payload.caption
$dateText = [string]$payload.date
$source = [System.Drawing.Image]::FromFile($wallpaperPath)
try {
  $targetWidth = [Math]::Max(1, [int]$physicalSize[0])
  $targetHeight = [Math]::Max(1, [int]$physicalSize[1])
  $bitmap = New-Object System.Drawing.Bitmap($targetWidth, $targetHeight)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.Clear([System.Drawing.Color]::Black)

      $targetAspect = $targetWidth / $targetHeight
      $sourceAspect = $source.Width / $source.Height
      $isPortrait = $sourceAspect -lt 0.86

      if ($isPortrait) {
        $bgScale = [Math]::Max($targetWidth / $source.Width, $targetHeight / $source.Height)
        $bgWidth = [int][Math]::Ceiling($source.Width * $bgScale)
        $bgHeight = [int][Math]::Ceiling($source.Height * $bgScale)
        $bgX = [int][Math]::Floor(($targetWidth - $bgWidth) / 2)
        $bgY = [int][Math]::Floor(($targetHeight - $bgHeight) / 2)
        $graphics.DrawImage($source, $bgX, $bgY, $bgWidth, $bgHeight)

        $veil = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(92, 18, 18, 18))
        try {
          $graphics.FillRectangle($veil, 0, 0, $targetWidth, $targetHeight)
        } finally {
          $veil.Dispose()
        }

        $fgScale = [Math]::Min(($targetWidth * 0.72) / $source.Width, ($targetHeight * 0.94) / $source.Height)
        $fgWidth = [int][Math]::Floor($source.Width * $fgScale)
        $fgHeight = [int][Math]::Floor($source.Height * $fgScale)
        $fgX = [int][Math]::Floor(($targetWidth - $fgWidth) / 2)
        $fgY = [int][Math]::Floor(($targetHeight - $fgHeight) / 2)
        $shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(90, 0, 0, 0))
        try {
          $graphics.FillRectangle($shadowBrush, $fgX - 18, $fgY - 18, $fgWidth + 36, $fgHeight + 36)
        } finally {
          $shadowBrush.Dispose()
        }
        $graphics.DrawImage($source, $fgX, $fgY, $fgWidth, $fgHeight)
      } else {
        $scale = [Math]::Max($targetWidth / $source.Width, $targetHeight / $source.Height)
        $drawWidth = [int][Math]::Ceiling($source.Width * $scale)
        $drawHeight = [int][Math]::Ceiling($source.Height * $scale)
        $drawX = [int][Math]::Floor(($targetWidth - $drawWidth) / 2)
        $drawY = [int][Math]::Floor(($targetHeight - $drawHeight) / 2)
        $graphics.DrawImage($source, $drawX, $drawY, $drawWidth, $drawHeight)
      }

      if (![string]::IsNullOrWhiteSpace($caption)) {
        $fontSize = [Math]::Max(28, [Math]::Min(62, [int][Math]::Round($targetWidth / 58)))
        $dateFontSize = [Math]::Max(13, [Math]::Min(22, [int][Math]::Round($fontSize * 0.42)))
        $captionFont = New-Object System.Drawing.Font("Microsoft YaHei UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $dateFont = New-Object System.Drawing.Font("Microsoft YaHei UI", $dateFontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
        try {
          $maxTextWidth = [Math]::Min($targetWidth * 0.42, 1160)
          $maxTextWidth = [Math]::Max($maxTextWidth, [Math]::Min($targetWidth * 0.72, 520))
          $lines = Get-WrappedTextLines $graphics $caption $captionFont $maxTextWidth 3
          $lineHeight = [int][Math]::Ceiling($fontSize * 1.42)
          $dateHeight = 0
          if (![string]::IsNullOrWhiteSpace($dateText)) {
            $dateHeight = [int][Math]::Ceiling($dateFontSize * 1.65)
          }

          $textWidth = 1
          foreach ($line in $lines) {
            $textWidth = [Math]::Max($textWidth, [int][Math]::Ceiling($graphics.MeasureString($line, $captionFont).Width))
          }
          if (![string]::IsNullOrWhiteSpace($dateText)) {
            $textWidth = [Math]::Max($textWidth, [int][Math]::Ceiling($graphics.MeasureString($dateText, $dateFont).Width))
          }

          $padX = [int][Math]::Max(28, [Math]::Round($targetWidth * 0.018))
          $padY = [int][Math]::Max(22, [Math]::Round($targetHeight * 0.018))
          $safeX = [int][Math]::Max(54, [Math]::Round($targetWidth * 0.035))
          $safeY = [int][Math]::Max(48, [Math]::Round($targetHeight * 0.04))
          $blockWidth = [int][Math]::Min($targetWidth - $safeX * 2, $textWidth + $padX * 2)
          $blockHeight = [int]($lines.Count * $lineHeight + $dateHeight + $padY * 2)
          $blockX = [int]($targetWidth - $blockWidth - $safeX)
          $blockY = [int]($targetHeight - $blockHeight - $safeY)

          $panelBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(104, 26, 23, 18))
          $lineBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(178, 255, 250, 241))
          $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(246, 255, 250, 241))
          $mutedBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(184, 238, 228, 211))
          $shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(132, 0, 0, 0))
          try {
            $graphics.FillRectangle($panelBrush, $blockX, $blockY, $blockWidth, $blockHeight)
            $graphics.FillRectangle($lineBrush, $blockX, $blockY, 3, $blockHeight)
            $textX = $blockX + $padX
            $textY = $blockY + $padY
            foreach ($line in $lines) {
              $graphics.DrawString($line, $captionFont, $shadowBrush, $textX + 2, $textY + 2)
              $graphics.DrawString($line, $captionFont, $textBrush, $textX, $textY)
              $textY += $lineHeight
            }
            if (![string]::IsNullOrWhiteSpace($dateText)) {
              $graphics.DrawString($dateText.Replace("-", "."), $dateFont, $shadowBrush, $textX + 1, $textY + 2)
              $graphics.DrawString($dateText.Replace("-", "."), $dateFont, $mutedBrush, $textX, $textY)
            }
          } finally {
            $panelBrush.Dispose()
            $lineBrush.Dispose()
            $textBrush.Dispose()
            $mutedBrush.Dispose()
            $shadowBrush.Dispose()
          }
        } finally {
          $captionFont.Dispose()
          $dateFont.Dispose()
        }
      }
    } finally {
      $graphics.Dispose()
    }

    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" } | Select-Object -First 1
    $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 92L)
    $bitmap.Save($outputPath, $codec, $params)
  } finally {
    $bitmap.Dispose()
  }
} finally {
  $source.Dispose()
}

$monitorId = [DesktopWallpaperTools]::FindMonitorId($screen.Left, $screen.Top, $screen.Right, $screen.Bottom)
[DesktopWallpaperTools]::SetPositionFill()
[DesktopWallpaperTools]::SetWallpaper($monitorId, $outputPath)
`;
  try {
    await runPowerShell(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
    cleanupWallpaperCache(outputPath);
  } finally {
    fs.promises.unlink(payloadPath).catch(() => {});
  }
}

function wallpaperCycleStatus() {
  return {
    enabled: Boolean(data.config.wallpaperCycleEnabled),
    index: Number(data.config.wallpaperCycleIndex || 0),
    intervalMs: Number(data.config.wallpaperCycleIntervalMs || DEFAULT_CONFIG.wallpaperCycleIntervalMs)
  };
}

async function applyWallpaperCycleStep(options = {}) {
  const photos = selectDailyTen();
  if (photos.length === 0) {
    throw new Error("还没有可用于循环的旧日来信照片。");
  }

  const currentIndex = Number(data.config.wallpaperCycleIndex || 0);
  const index = options.next ? (currentIndex + 1) % photos.length : currentIndex % photos.length;
  const photo = photos[index];
  await setWindowsWallpaper(photo.path, wallpaperPayloadForPhoto(photo));
  data.config.wallpaperCycleIndex = index;
  saveData();
  sendWorkflowStatus(`桌面循环已切到第 ${index + 1} / ${photos.length} 张。`);
  return {
    photoId: photo.id,
    status: wallpaperCycleStatus()
  };
}

function stopWallpaperCycleTimer() {
  if (wallpaperCycleTimer) {
    clearInterval(wallpaperCycleTimer);
    wallpaperCycleTimer = null;
  }
}

function scheduleWallpaperCycle() {
  stopWallpaperCycleTimer();
  if (!data.config.wallpaperCycleEnabled) return;
  const intervalMs = Number(data.config.wallpaperCycleIntervalMs || DEFAULT_CONFIG.wallpaperCycleIntervalMs);
  wallpaperCycleTimer = setInterval(() => {
    applyWallpaperCycleStep({ next: true }).catch((error) => {
      sendWorkflowStatus(`桌面循环切换失败：${error.message}`);
    });
  }, Math.max(60000, intervalMs));
}

async function setWallpaperCycleEnabled(enabled) {
  if (!enabled) {
    data.config.wallpaperCycleEnabled = false;
    stopWallpaperCycleTimer();
    const previous = {
      wallpaper: data.config.previousWallpaper,
      wallpaperStyle: data.config.previousWallpaperStyle,
      tileWallpaper: data.config.previousTileWallpaper,
      wallpapers: data.config.previousWallpapers
    };
    await restoreDesktopWallpaper(previous);
    data.config.previousWallpaper = "";
    data.config.previousWallpaperStyle = "10";
    data.config.previousTileWallpaper = "0";
    data.config.previousWallpapers = "";
    saveData();
    sendWorkflowStatus("桌面循环已关闭，已恢复原来的壁纸。");
    return wallpaperCycleStatus();
  }

  if (!data.config.wallpaperCycleEnabled) {
    const current = await readDesktopWallpaperSettings();
    const cacheDir = wallpaperCacheDir().toLowerCase();
    const currentWallpaper = String(current.wallpaper || "");
    const isCurrentCycleCache = currentWallpaper.toLowerCase().startsWith(cacheDir);
    if (currentWallpaper && !isCurrentCycleCache) {
      data.config.previousWallpaper = currentWallpaper;
      data.config.previousWallpaperStyle = current.wallpaperStyle || "10";
      data.config.previousTileWallpaper = current.tileWallpaper || "0";
      data.config.previousWallpapers = JSON.stringify(current.wallpapers || []);
    } else if (!data.config.previousWallpaper) {
      data.config.previousWallpaper = defaultWindowsWallpaperPath();
      data.config.previousWallpaperStyle = "10";
      data.config.previousTileWallpaper = "0";
      data.config.previousWallpapers = "";
    }
  }

  data.config.wallpaperCycleEnabled = true;
  await applyWallpaperCycleStep({ next: false });
  scheduleWallpaperCycle();
  saveData();
  sendWorkflowStatus("桌面循环已开启，每小时切换一张。");
  return wallpaperCycleStatus();
}

ipcMain.handle("app:get-state", async () => {
  data.config.autoLaunchEnabled = readAutoLaunchEnabled();
  const previewPhotos = publicPhotoPreviewList(data.photos);
  const dailyTen = publicPhotos(selectDailyTen());
  return {
    folders: data.folders,
    photoCount: data.photos.length,
    photos: previewPhotos,
    analyses: analysesForUi([...previewPhotos, ...dailyTen]),
    config: { ...data.config, apiKey: data.config.apiKey ? "********" : "" },
    dailyTen,
    todayKey: localDateKey(),
    wallpaperCycle: wallpaperCycleStatus()
  };
});

ipcMain.handle("folders:pick", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择旧照片文件夹",
    properties: ["openDirectory", "multiSelections"]
  });
  if (result.canceled) return null;
  if (data.config.wallpaperCycleEnabled) {
    await setWallpaperCycleEnabled(false);
  }
  data.config.wallpaperCycleIndex = 0;
  data.folders = Array.from(new Set(result.filePaths));
  data.analyses = {};
  saveData();
  return data.folders;
});

ipcMain.handle("photos:scan", async (_event, folders) => {
  const selected = Array.isArray(folders) && folders.length > 0 ? folders : data.folders;
  const scanned = (await Promise.all(selected.map((folder) => walkPhotos(folder)))).flat();
  const selectedSet = new Set(selected.map((folder) => path.resolve(folder).toLowerCase()));
  const existingById = new Map(
    data.photos
      .filter((photo) => selectedSet.has(path.resolve(photo.folder).toLowerCase()))
      .map((photo) => [photo.id, photo])
  );
  data.photos = scanned.map((photo) => ({
    ...photo,
    exif: photo.exif || existingById.get(photo.id)?.exif || {},
    localScore: photo.localScore || localPhotoScores(photo),
    favorite: existingById.get(photo.id)?.favorite || false,
    hidden: existingById.get(photo.id)?.hidden || false
  }));
  data.folders = selected;
  saveData();
  const previewPhotos = publicPhotoPreviewList(data.photos);
  const dailyTen = publicPhotos(selectDailyTen());
  return {
    photos: previewPhotos,
    photoCount: data.photos.length,
    analyses: analysesForUi([...previewPhotos, ...dailyTen]),
    dailyTen,
    todayKey: localDateKey()
  };
});

ipcMain.handle("config:save", async (_event, config) => {
  const currentApiKey = data.config.apiKey;
  const nextConfig = {
    ...data.config,
    ...config,
    apiKey: config.apiKey === "********" ? currentApiKey : String(config.apiKey || "")
  };
  nextConfig.model = canonicalModelForProvider(nextConfig.model, nextConfig.baseUrl);
  data.config = {
    ...nextConfig
  };
  applyAutoLaunchSetting(Boolean(data.config.autoLaunchEnabled));
  data.config.autoLaunchEnabled = readAutoLaunchEnabled();
  saveData();
  return { ...data.config, apiKey: data.config.apiKey ? "********" : "" };
});

ipcMain.handle("llm:analyze-photo", async (_event, photoId) => analyzePhoto(photoId));

ipcMain.handle("llm:analyze-daily-ten", async (_event, photoIds, options = {}) => {
  const ids = Array.isArray(photoIds) && photoIds.length > 0 ? photoIds : selectDailyTen().map((photo) => photo.id);
  return analyzePhotosBatch(ids, options);
});

ipcMain.handle("llm:prepare-daily-letter", async (_event, options = {}) => prepareDailyLetter(options));

ipcMain.handle("wallpaper:set", async (_event, photoId) => {
  const photo = data.photos.find((item) => item.id === photoId);
  if (!photo) throw new Error("Photo not found.");
  await setWindowsWallpaper(photo.path, wallpaperPayloadForPhoto(photo));
  return true;
});

ipcMain.handle("wallpaper:cycle-set", async (_event, enabled) => setWallpaperCycleEnabled(Boolean(enabled)));

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusMainWindow();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      return;
    }
    focusMainWindow();
  });

  app.whenReady().then(() => {
    loadData();
    applyAutoLaunchSetting(Boolean(data.config.autoLaunchEnabled));
    registerPhotoProtocol();
    createWindow();
    if (data.config.wallpaperCycleEnabled) {
      applyWallpaperCycleStep({ next: false }).catch((error) => {
        sendWorkflowStatus(`桌面循环恢复失败：${error.message}`);
      });
    }
    scheduleWallpaperCycle();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
