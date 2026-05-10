import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Aperture,
  FolderOpen,
  KeyRound,
  Loader2,
  MapPin,
  Moon,
  Play,
  Ruler,
  Scan,
  Settings,
  Sparkles,
  RefreshCw,
  Wallpaper,
  PanelLeftClose,
  PanelLeftOpen
} from "lucide-react";
import "./styles.css";

const api = window.timeWallpaper;

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function metricText(state) {
  const count = state.photoCount ?? state.photos.length;
  if (count === 0) return "还没有旧照片进入时间线";
  return `${count} 张照片已进入时间线`;
}

function App() {
  const [state, setState] = useState({
    folders: [],
    photos: [],
    photoCount: 0,
    analyses: {},
    dailyTen: [],
    config: {},
    todayKey: localDateKey(),
    wallpaperCycle: { enabled: false, index: 0, intervalMs: 3600000 }
  });
  const [active, setActive] = useState("letter");
  const [isBusy, setBusy] = useState(false);
  const [message, setMessage] = useState("选择一个旧照片文件夹，先让时间开始流动。");
  const [readerOpen, setReaderOpen] = useState(false);
  const [letterOpening, setLetterOpening] = useState(false);
  const [readerIndex, setReaderIndex] = useState(0);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [configDraft, setConfigDraft] = useState({});
  const openingTimers = useRef([]);
  const stateRef = useRef(state);
  const dayKeyRef = useRef(localDateKey());
  const dayRefreshRef = useRef(false);
  const dailyPrepareRef = useRef(false);
  const libraryRefreshRef = useRef(false);
  const lastLibraryCheckRef = useRef(0);
  const nextDayPrepareRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  function needsDailyPreparation(snapshot) {
    return Boolean(
      snapshot?.folders?.length
      && snapshot?.dailyTen?.length
      && snapshot.dailyTen.some((photo) => !snapshot.analyses?.[photo.id]?.captions?.[0]?.text)
    );
  }

  async function ensureDailyLetterPrepared(snapshot) {
    if (dailyPrepareRef.current || dayRefreshRef.current || !needsDailyPreparation(snapshot)) return;
    dailyPrepareRef.current = true;
    setBusy(true);
    setReaderOpen(false);
    setLetterOpening(false);
    setMessage("正在给今天的十张照片评分和写信，写好前先不拆开旧日来信。");
    try {
      await api.prepareDailyLetter({ force: false });
      const ready = await api.getState();
      dayKeyRef.current = ready.todayKey || localDateKey();
      setState(ready);
      setConfigDraft(ready.config || {});
      setMessage("今天的旧日来信已经写好。");
      warmNextDayLetter(ready);
    } catch (error) {
      setMessage(error?.message || "今天的旧日来信还没有写好，请检查 LLM 设置后重试。");
    } finally {
      dailyPrepareRef.current = false;
      setBusy(false);
    }
  }

  async function warmNextDayLetter(snapshot = stateRef.current) {
    if (!api.prepareNextDayLetter || nextDayPrepareRef.current || !snapshot?.folders?.length || !snapshot?.dailyTen?.length) return;
    nextDayPrepareRef.current = true;
    try {
      await api.prepareNextDayLetter({ force: false });
    } catch (error) {
      setMessage(error?.message || "明天的旧日来信还没有提前准备成功。");
    } finally {
      nextDayPrepareRef.current = false;
    }
  }

  async function refreshLibraryIfChanged(snapshot = stateRef.current, options = {}) {
    if (!api.refreshPhotosIfChanged || libraryRefreshRef.current || dailyPrepareRef.current || dayRefreshRef.current) return;
    if (!snapshot?.folders?.length) return;
    const now = Date.now();
    if (!options.force && now - lastLibraryCheckRef.current < 180000) return;
    lastLibraryCheckRef.current = now;
    libraryRefreshRef.current = true;
    setBusy(true);
    setReaderOpen(false);
    setLetterOpening(false);
    setMessage("正在检查照片文件夹有没有新的回声。");
    try {
      const next = await api.refreshPhotosIfChanged();
      setState(next);
      setConfigDraft(next.config || {});
      if (!next.libraryChanged) {
        if (needsDailyPreparation(next)) await ensureDailyLetterPrepared(next);
        else warmNextDayLetter(next);
        return;
      }
      if ((next.dailyTen || []).length === 0) {
        setMessage("照片库已更新，但还没有可用的旧日来信照片。");
        return;
      }
      setState((old) => ({ ...old, ...next, analyses: {}, dailyTen: [] }));
      setMessage("照片库已更新，正在重新筛选十张并让 AI 写好文案。");
      await api.prepareDailyLetter({ force: true });
      const ready = await api.getState();
      dayKeyRef.current = ready.todayKey || localDateKey();
      setState(ready);
      setConfigDraft(ready.config || {});
      setMessage("新的照片已经写好今天的旧日来信。");
      warmNextDayLetter(ready);
    } catch (error) {
      setMessage(error?.message || "照片库已更新，但 AI 文案还没有生成成功。");
    } finally {
      libraryRefreshRef.current = false;
      setBusy(false);
    }
  }

  async function refresh(options = {}) {
    try {
      const next = await api.getState();
      dayKeyRef.current = next.todayKey || localDateKey();
      setState(next);
      setConfigDraft(next.config || {});
      if (options.checkLibrary) {
        refreshLibraryIfChanged(next, { force: true });
      } else if (options.prepareMissing !== false) {
        if (needsDailyPreparation(next)) ensureDailyLetterPrepared(next);
        else warmNextDayLetter(next);
      }
    } catch (error) {
      setMessage(error?.message || "启动状态读取失败，请重启应用再试。");
    }
  }

  async function refreshIfDayChanged() {
    const nextDay = localDateKey();
    if (dayRefreshRef.current || dayKeyRef.current === nextDay) return;
    dayRefreshRef.current = true;
    setBusy(true);
    setReaderOpen(false);
    setLetterOpening(false);
    setReaderIndex(0);
    setState((old) => ({ ...old, dailyTen: [], analyses: {} }));
    setMessage("新的一天到了，正在重新翻找今天的回声。");
    try {
      if (stateRef.current.folders.length > 0) {
        await api.prepareDailyLetter({ force: false });
      }
      await refresh({ prepareMissing: false });
      setMessage("今天的旧日来信已经换新。");
      warmNextDayLetter(stateRef.current);
    } catch (error) {
      await refresh({ prepareMissing: false });
      setMessage(error?.message || "新一天的旧日来信还没有写好，请检查 LLM 设置后重试。");
    } finally {
      dayKeyRef.current = nextDay;
      dayRefreshRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    refresh({ prepareMissing: true, checkLibrary: true });
    const unsubscribe = api.onWorkflowStatus?.((nextMessage) => {
      setMessage(nextMessage);
    });
    return () => {
      openingTimers.current.forEach((timer) => clearTimeout(timer));
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      refreshIfDayChanged();
      refreshLibraryIfChanged();
    }, 60000);
    const onFocus = () => {
      refreshIfDayChanged();
      refreshLibraryIfChanged();
    };
    const onVisibility = () => {
      if (!document.hidden) {
        refreshIfDayChanged();
        refreshLibraryIfChanged();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const currentPhoto = state.dailyTen[readerIndex];
  const currentAnalysis = currentPhoto ? state.analyses[currentPhoto.id] : null;
  const hasCaption = (photo, analyses = state.analyses) => Boolean(analyses[photo.id]?.captions?.[0]?.text);

  const dailySummary = useMemo(() => {
    if (state.dailyTen.length === 0) return "今天的来信还在路上。";
    const hasToday = state.dailyTen.some((photo) => {
      const date = new Date(`${photo.date}T00:00:00`);
      const now = new Date();
      return date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    });
    return hasToday ? "今天，过去把同一天的光重新递了回来。" : "今天，时间挑了十个安静的瞬间。";
  }, [state.dailyTen]);

  async function pickFolders() {
    setBusy(true);
    setMessage("正在等待你选择照片文件夹。");
    try {
      const folders = await api.pickFolders();
      if (!folders) {
        setMessage("已取消选择文件夹。");
        return;
      }
      if (folders.length === 0) {
        setState((old) => ({ ...old, folders }));
        setMessage("还没有选择文件夹。");
        return;
      }
      setReaderOpen(false);
      setReaderIndex(0);
      setState((old) => ({
        ...old,
        folders,
        photos: [],
        photoCount: 0,
        analyses: {},
        dailyTen: []
      }));
      setMessage("旧日来信已经收起，正在为新文件夹翻找今天的光。");
      await api.scanPhotos(folders);
      const next = await api.getState();
      setState((old) => ({ ...old, folders: next.folders, photos: next.photos, analyses: {}, dailyTen: [] }));
      setConfigDraft(next.config || {});
      setMessage(`找到 ${next.photoCount ?? next.photos.length} 张照片。正在给那年今日的十个瞬间写来信。`);
      if ((next.dailyTen || []).length === 0) {
        setMessage("这个文件夹里还没有可用的旧日来信照片。");
        return;
      }
      await api.prepareDailyLetter({ force: true });
      const ready = await api.getState();
      const readyCount = (ready.dailyTen || []).filter((photo) => ready.analyses?.[photo.id]?.captions?.[0]?.text).length;
      if (readyCount !== (ready.dailyTen || []).length) {
        throw new Error("新文件夹的十张照片还没有全部生成文案。");
      }
      setState(ready);
      setConfigDraft(ready.config || {});
      setMessage("新的旧日来信已经写好。");
      warmNextDayLetter(ready);
    } catch (error) {
      setMessage(error?.message || "旧日来信还没有写好，请检查 LLM 设置后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function scanPhotos() {
    setBusy(true);
    setMessage("正在建立本地照片索引，不上传原图。");
    try {
      setReaderOpen(false);
      setReaderIndex(0);
      setState((old) => ({
        ...old,
        analyses: {},
        dailyTen: []
      }));
      await api.scanPhotos(state.folders);
      const next = await api.getState();
      setState((old) => ({ ...old, ...next, analyses: {}, dailyTen: [] }));
      setConfigDraft(next.config || {});
      setMessage(`扫描完成，找到 ${next.photoCount ?? next.photos.length} 张照片。正在给那年今日的十个瞬间写来信。`);
      if ((next.dailyTen || []).length === 0) {
        setMessage("这个文件夹里还没有可用的旧日来信照片。");
        return;
      }
      await api.prepareDailyLetter({ force: true });
      const ready = await api.getState();
      const readyCount = (ready.dailyTen || []).filter((photo) => ready.analyses?.[photo.id]?.captions?.[0]?.text).length;
      if (readyCount !== (ready.dailyTen || []).length) {
        throw new Error("新文件夹的十张照片还没有全部生成文案。");
      }
      setState(ready);
      setConfigDraft(ready.config || {});
      setMessage("新的旧日来信已经写好。");
      warmNextDayLetter(ready);
    } catch (error) {
      setMessage(error?.message || "旧日来信还没有写好，请检查 LLM 设置后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function analyzeDailyTen(options = {}) {
    if ((state.photoCount ?? state.photos.length) === 0) return false;
    const force = Boolean(options.force);
    const requireAll = Boolean(options.requireAll);
    setBusy(true);
    if (force) {
      setState((old) => ({ ...old, analyses: {} }));
    }
    setMessage(force ? "正在重新生成精选十张的文案。" : "正在为本地精选出的十张生成文案。");
    try {
      const config = state.config || {};
      const isXiaomi = (config.baseUrl || "").includes("xiaomimimo");
      const model = (config.model || "").toLowerCase();
      if ((config.privacyMode || "feature_only") !== "visual_opt_in") {
        throw new Error("旧日来信需要模型读取图片。请到 LLM 设置里选择 visual opt-in。");
      }
      if (isXiaomi && !["mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-omni"].includes(model)) {
        throw new Error("当前 MiMo 模型未确认为可读图模型。请使用 mimo-v2.5 或 mimo-v2-omni。");
      }
      const ids = state.dailyTen.map((photo) => photo.id);
      const results = await api.analyzeDailyTen(ids, { force });
      const analyses = force ? {} : { ...state.analyses };
      for (const item of results) analyses[item.photoId] = item;
      const refreshed = await api.getState();
      const nextDailyTen = refreshed.dailyTen || state.dailyTen;
      setState((old) => ({ ...old, ...refreshed, analyses: { ...(refreshed.analyses || {}), ...analyses }, dailyTen: nextDailyTen }));
      const readyCount = nextDailyTen.filter((photo) => hasCaption(photo, analyses)).length;
      if (readyCount === nextDailyTen.length) {
        setMessage("已为本地精选出的今日十张生成文案。");
        warmNextDayLetter({ ...refreshed, dailyTen: nextDailyTen });
        return true;
      }
      setMessage(`还有 ${nextDailyTen.length - readyCount} 张没有有效 AI 文案，暂时不能拆开来信。`);
      return !requireAll;
    } catch (error) {
      setMessage(error?.message || "LLM 文案生成失败，暂时不能拆开来信。");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig() {
    setBusy(true);
    setMessage("正在保存 LLM 配置。");
    try {
      const config = await api.saveConfig(configDraft);
      setState((old) => ({ ...old, config }));
      setConfigDraft(config);
      setMessage("LLM 配置已保存。");
    } finally {
      setBusy(false);
    }
  }

  async function setWallpaper(photoId) {
    setBusy(true);
    setMessage("正在设置 Windows 壁纸。");
    try {
      await api.setWallpaper(photoId);
      setMessage("壁纸已经换好。");
    } finally {
      setBusy(false);
    }
  }

  async function toggleWallpaperCycle(enabled) {
    setBusy(true);
    setMessage(enabled ? "正在开启桌面循环，先把第一张旧日来信设为壁纸。" : "正在关闭桌面循环。");
    try {
      const wallpaperCycle = await api.setWallpaperCycle(enabled);
      const next = await api.getState();
      setState((old) => ({ ...old, ...next, wallpaperCycle }));
      setConfigDraft(next.config || {});
      setMessage(enabled ? "桌面循环已开启，每小时切换一张。" : "桌面循环已关闭。");
    } catch (error) {
      setMessage(error?.message || "桌面循环设置失败。");
    } finally {
      setBusy(false);
    }
  }

  function openReader(index = 0) {
    const photo = state.dailyTen[index];
    if (photo && !hasCaption(photo)) {
      setMessage("这张照片还没有 AI 文案，先生成文案再打开。");
      return;
    }
    setReaderIndex(index);
    setReaderOpen(true);
  }

  async function openLetterCeremony() {
    if (state.dailyTen.length === 0 || letterOpening || isBusy) return;
    const ready = await analyzeDailyTen({ requireAll: true });
    if (!ready) return;
    openingTimers.current.forEach((timer) => clearTimeout(timer));
    openingTimers.current = [];
    setReaderIndex(0);
    setLetterOpening(true);
    setReaderOpen(false);
    openingTimers.current.push(setTimeout(() => {
      setLetterOpening(false);
      setReaderOpen(true);
    }, 3600));
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Moon size={18} /></div>
          <div>
            <strong>时间壁纸</strong>
            <span>Memory Wallpaper</span>
          </div>
        </div>
        <button className="sidebar-toggle" onClick={() => setSidebarCollapsed((value) => !value)} title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}>
          {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>

        <nav>
          <button className={active === "letter" ? "active" : ""} onClick={() => setActive("letter")}>
            <Sparkles size={18} /> 旧日来信
          </button>
          <button className={active === "library" ? "active" : ""} onClick={() => setActive("library")}>
            <Camera size={18} /> 时间线
          </button>
          <button className={active === "settings" ? "active" : ""} onClick={() => setActive("settings")}>
            <Settings size={18} /> LLM 设置
          </button>
        </nav>

        <div className="status-panel">
          <div className="status-head">
            <span>{metricText(state)}</span>
            {isBusy ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
          </div>
          <small>{message}</small>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <span className="eyebrow">今天的时间</span>
            <h1>{active === "letter" ? "过去寄来十个瞬间" : active === "library" ? "本地照片时间线" : "文案生成 Prompt 管理"}</h1>
          </div>
          <div className="actions">
            <button onClick={pickFolders}><FolderOpen size={17} /> 选文件夹</button>
            <button onClick={scanPhotos} disabled={state.folders.length === 0 || isBusy}><Scan size={17} /> 扫描</button>
          </div>
        </header>

        {active === "letter" && (
          <LetterView
            photos={state.dailyTen}
            analyses={state.analyses}
            summary={dailySummary}
            onOpen={openReader}
            onOpenLetter={openLetterCeremony}
            onAnalyze={analyzeDailyTen}
            onRegenerate={() => analyzeDailyTen({ force: true })}
            wallpaperCycle={state.wallpaperCycle}
            onToggleWallpaperCycle={toggleWallpaperCycle}
            busy={isBusy}
          />
        )}

        {active === "library" && (
          <LibraryView
            photos={state.photos}
            analyses={state.analyses}
            onOpen={(photo) => {
              const idx = state.dailyTen.findIndex((item) => item.id === photo.id);
              openReader(Math.max(idx, 0));
            }}
          />
        )}

        {active === "settings" && (
          <SettingsView
            config={configDraft}
            setConfig={setConfigDraft}
            onSave={saveConfig}
            busy={isBusy}
          />
        )}
      </main>

      {readerOpen && currentPhoto && (
        <Reader
          photo={currentPhoto}
          analysis={currentAnalysis}
          total={state.dailyTen.length}
          index={readerIndex}
          onClose={() => setReaderOpen(false)}
          onPrev={() => setReaderIndex((value) => Math.max(0, value - 1))}
          onNext={() => setReaderIndex((value) => Math.min(state.dailyTen.length - 1, value + 1))}
          onWallpaper={() => setWallpaper(currentPhoto.id)}
        />
      )}

      {letterOpening && (
        <LetterOpening
          photos={state.dailyTen}
          summary={dailySummary}
          onSkip={() => {
            openingTimers.current.forEach((timer) => clearTimeout(timer));
            openingTimers.current = [];
            setLetterOpening(false);
            openReader(0);
          }}
        />
      )}
    </div>
  );
}

function LetterView({ photos, analyses, summary, onOpen, onOpenLetter, onAnalyze, onRegenerate, wallpaperCycle, onToggleWallpaperCycle, busy }) {
  const readyCount = photos.filter((photo) => analyses[photo.id]?.captions?.[0]?.text).length;

  if (photos.length === 0) {
    return (
      <section className="letter-stage">
        <div className="letter-waiting">
          <Sparkles size={28} />
          <span>{busy ? "正在翻找今天的回声" : "旧日来信还在路上"}</span>
          <p>{busy ? "先让时间慢慢翻页，等十张照片和它们的句子一起抵达。" : "选择一个旧照片文件夹，今天会从过去寄来十个瞬间。"}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="letter-stage">
      <div className="letter-command">
        <div>
          <span className="eyebrow">旧日来信</span>
          <p>{summary}</p>
        </div>
        <div className="letter-actions">
          <label className={`cycle-switch ${wallpaperCycle?.enabled ? "active" : ""}`}>
            <input
              type="checkbox"
              checked={Boolean(wallpaperCycle?.enabled)}
              disabled={photos.length === 0 || busy}
              onChange={(event) => onToggleWallpaperCycle(event.target.checked)}
            />
            <span><Wallpaper size={16} /> 桌面循环</span>
          </label>
          <button className="primary" onClick={onOpenLetter} disabled={photos.length === 0 || busy}>
            <Play size={18} /> <span>拆开来信</span>
          </button>
          <div className="caption-tools">
            <button onClick={onAnalyze} disabled={photos.length === 0 || busy} title="为没有文案的照片生成">
              <Sparkles size={16} /> <span>生成文案</span>
            </button>
            <button onClick={onRegenerate} disabled={photos.length === 0 || busy} title="覆盖今日十张已有文案">
              <RefreshCw size={16} /> <span>重新生成</span>
            </button>
          </div>
        </div>
      </div>

      <div className="letter-wall">
        {photos.slice(0, 10).map((photo, index) => (
          <button className={`letter-photo ${photo.exif?.orientation || ""}`} key={photo.id} onClick={() => onOpen(index)}>
            <img src={photo.fileUrl} alt="" loading="lazy" />
            <strong>{analyses[photo.id]?.captions?.[0]?.text || "等待这张照片开口"}</strong>
          </button>
        ))}
      </div>

      <div className="letter-progress">
        <span>{readyCount} / {photos.length} 张已有文案</span>
      </div>
    </section>
  );
}

function LetterOpening({ photos, summary, onSkip }) {
  return (
    <div className="opening-scene" onClick={onSkip}>
      <div className="opening-glow" />
      <div className="opening-stage" onClick={(event) => event.stopPropagation()}>
        <div className="opening-envelope">
          <div className="envelope-back" />
          <div className="opening-paper">
            <span>旧日来信</span>
            <strong>{summary}</strong>
            <small>今日十张</small>
          </div>
          <div className="envelope-front" />
          <div className="envelope-flap" />
        </div>
        <div className="opening-photos">
          {photos.slice(0, 10).map((photo, index) => (
            <div
              key={photo.id}
              className={`opening-photo ${photo.exif?.orientation === "landscape" ? "landscape" : "portrait"}`}
              style={{
                "--i": index,
                "--x": `${(index - 4.5) * 26}px`,
                "--y": `${Math.abs(index - 4.5) * -7}px`,
                "--r": `${(index - 4.5) * 3.2}deg`
              }}
            >
              <img src={photo.fileUrl} alt="" />
            </div>
          ))}
        </div>
        <button className="opening-skip" onClick={onSkip}>进入阅读</button>
      </div>
    </div>
  );
}

function LibraryView({ photos, analyses, onOpen }) {
  if (photos.length === 0) {
    return (
      <section className="empty-state">
        <FolderOpen size={42} />
        <h2>先选择一个旧照片文件夹</h2>
        <p>程序会只在本地建立索引。默认不会上传原图，也不会识别人名。</p>
      </section>
    );
  }

  return (
    <section className="library-grid">
      {photos.slice(0, 120).map((photo) => (
        <button className={`library-card ${photo.exif?.orientation || ""}`} key={photo.id} onClick={() => onOpen(photo)}>
          <img src={photo.fileUrl} alt="" loading="lazy" />
          <div>
            <span>{photo.date}</span>
            <strong>{analyses[photo.id]?.captions?.[0]?.text || photo.name}</strong>
          </div>
        </button>
      ))}
    </section>
  );
}

function SettingsView({ config, setConfig, onSave, busy }) {
  function applyPreset(type) {
    if (type === "xiaomi-openai") {
      setConfig({
        ...config,
        protocol: "openai",
        baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
        model: "mimo-v2.5",
        privacyMode: "visual_opt_in"
      });
    }
    if (type === "xiaomi-anthropic") {
      setConfig({
        ...config,
        protocol: "anthropic",
        baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
        model: "mimo-v2.5",
        privacyMode: "feature_only"
      });
    }
  }

  const isXiaomi = (config.baseUrl || "").includes("xiaomimimo");
  const xiaomiVisionModels = ["mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-omni"];
  const isXiaomiNonVision = isXiaomi && !xiaomiVisionModels.includes((config.model || "").toLowerCase());

  return (
    <section className="settings-layout">
      <div className="settings-copy">
        <KeyRound size={28} />
        <h2>稳定 Prompt，而不是一句“生成诗意文案”</h2>
        <p>
          当前实现使用固定 System Prompt、结构化照片输入和程序校验三层约束。
          如果开启读图模式，图片会以视觉输入发送到你配置的 OpenAI-compatible 服务；默认 feature-only 只发送结构化信息。
        </p>
      </div>
      <div className="settings-form">
        <div className="preset-row">
          <button type="button" onClick={() => applyPreset("xiaomi-openai")}>小米 OpenAI 预设</button>
          <button type="button" onClick={() => applyPreset("xiaomi-anthropic")}>小米 Anthropic 预设</button>
        </div>
        <label>
          协议
          <select
            value={config.protocol || "openai"}
            onChange={(event) => setConfig({ ...config, protocol: event.target.value })}
          >
            <option value="openai">OpenAI-compatible / 百炼 / OpenRouter / vLLM</option>
            <option value="anthropic">Anthropic-compatible / Claude Code 类接口</option>
          </select>
        </label>
        <label>
          服务地址
          <input
            placeholder={(config.protocol || "openai") === "anthropic" ? "https://api.example.com/v1" : "https://api.openai.com/v1"}
            value={config.baseUrl || ""}
            onChange={(event) => setConfig({ ...config, baseUrl: event.target.value })}
          />
        </label>
        <label>
          API Key
          <input
            type="password"
            placeholder="sk-..."
            value={config.apiKey || ""}
            onChange={(event) => setConfig({ ...config, apiKey: event.target.value })}
          />
        </label>
        <label>
          模型 ID
          <input
            placeholder="gpt-4.1-mini / qwen-plus / ..."
            value={config.model || ""}
            onChange={(event) => setConfig({ ...config, model: event.target.value })}
          />
        </label>
        <label>
          隐私模式
          <select
            value={config.privacyMode || "feature_only"}
            onChange={(event) => setConfig({ ...config, privacyMode: event.target.value })}
          >
            <option value="feature_only">feature-only：只发结构化信息</option>
            <option value="visual_opt_in">visual opt-in：允许模型读取图片</option>
          </select>
        </label>
        {isXiaomi && (
          <p className="settings-hint">
            旧日来信必须读图，否则文案只能根据日期和 EXIF 猜，很容易跑偏。
            小米 MiMo 请使用小写模型 ID，例如 mimo-v2.5 或 mimo-v2-omni，并选择 visual opt-in。
            {isXiaomiNonVision && " 当前模型不能读图，拆信前会被拦截。"}
          </p>
        )}
        <label>
          文案风格
          <input
            value={config.captionStyle || ""}
            onChange={(event) => setConfig({ ...config, captionStyle: event.target.value })}
          />
        </label>
        <label>
          请求超时毫秒
          <input
            type="number"
            min="15000"
            step="5000"
            value={config.timeoutMs || 90000}
            onChange={(event) => setConfig({ ...config, timeoutMs: Number(event.target.value) })}
          />
        </label>
        <label className="settings-switch">
          <input
            type="checkbox"
            checked={Boolean(config.autoLaunchEnabled)}
            onChange={(event) => setConfig({ ...config, autoLaunchEnabled: event.target.checked })}
          />
          <span>
            <strong>开机自动启动</strong>
            <small>登录 Windows 后自动打开时间壁纸，适合配合桌面循环使用。</small>
          </span>
        </label>
        <button className="primary" onClick={onSave} disabled={busy}>
          <Check size={17} /> 保存配置
        </button>
      </div>
    </section>
  );
}

function Reader({ photo, analysis, total, index, onClose, onPrev, onNext, onWallpaper }) {
  const caption = analysis?.captions?.[0]?.text;
  if (!caption) return null;
  const exif = photo.exif || {};
  const dateSourceText =
    photo.dateSource === "exif"
      ? "拍摄日期"
      : photo.dateSource === "filename"
        ? "记录日期"
        : "记录日期";
  const sourceText =
    analysis?.source === "llm_visual" || analysis?.source === "llm_visual_batch"
      ? "AI 文案"
    : analysis?.source === "llm_feature_only" || analysis?.source === "llm_feature_batch"
        ? "AI 文案"
        : "AI 文案";
  const metaItems = [
    exif.camera ? { icon: <Camera size={15} />, label: "设备", value: exif.camera } : null,
    exif.lens ? { icon: <Aperture size={15} />, label: "镜头", value: exif.lens } : null,
    exif.location ? { icon: <MapPin size={15} />, label: "地点", value: exif.location } : null,
    exif.width && exif.height ? { icon: <Ruler size={15} />, label: "尺寸", value: `${exif.width} × ${exif.height}` } : null
  ].filter(Boolean);
  const hasWatermark = photo.date || metaItems.length > 0;

  return (
    <div className={`reader ${exif.orientation || ""}`}>
      <img className="reader-bg" src={photo.fileUrl} alt="" />
      <div className="reader-scrim" />
      <div className="reader-photo-stage">
        <img className="reader-photo-main" src={photo.fileUrl} alt="" />
      </div>
      <button className="reader-close" onClick={onClose}>收起</button>
      <button className="reader-nav left" onClick={onPrev} disabled={index === 0}><ChevronLeft /></button>
      <button className="reader-nav right" onClick={onNext} disabled={index === total - 1}><ChevronRight /></button>
      <div className="reader-content">
        <div className="reader-titlebar">
          <span className="reader-count">{String(index + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}</span>
          <span className="reader-source" title={analysis?.error || ""}>{sourceText}</span>
        </div>
        <h2>{caption}</h2>
        {hasWatermark && (
          <div className={`watermark-strip ${metaItems.length === 0 ? "date-only" : ""}`}>
            {photo.date && (
              <div className="date-lockup">
                <strong>{photo.date.replaceAll("-", ".")}</strong>
                <span>{dateSourceText}</span>
              </div>
            )}
            {metaItems.length > 0 && (
              <div className="meta-grid" style={{ "--meta-count": metaItems.length }}>
                {metaItems.map((item) => (
                  <MetaItem key={item.label} icon={item.icon} label={item.label} value={item.value} />
                ))}
              </div>
            )}
          </div>
        )}
        <div className="reader-tools">
          <button onClick={onWallpaper}><Wallpaper size={17} /> 设为壁纸</button>
          {exif.settings && <span>{exif.settings}</span>}
        </div>
      </div>
    </div>
  );
}

function MetaItem({ icon, label, value }) {
  return (
    <div className="meta-item">
      <span className="meta-icon">{icon}</span>
      <span className="meta-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
