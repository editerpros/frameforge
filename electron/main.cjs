const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1050,
    minHeight: 720,
    backgroundColor: '#0b0b10',
    title: 'FrameForge v1.3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (!app.isPackaged) win.loadURL('http://127.0.0.1:5173');
  else win.loadFile(path.join(__dirname, '../dist/index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-render-fonts', async () => {
  const windowsDir = process.env.WINDIR || process.env.SystemRoot || 'C\\Windows';
  const makeFilterPath = (fontName) => {
    const absolute = path.join(windowsDir, 'Fonts', fontName);
    return absolute.replace(/\\/g, '/').replace(/^([a-z]):/i, '$1\\:');
  };
  const regular = makeFilterPath('arial.ttf');
  const bold = makeFilterPath('arialbd.ttf');
  const malayalamRegularPath = path.join(windowsDir, 'Fonts', 'Nirmala.ttf');
  const malayalamBoldPath = path.join(windowsDir, 'Fonts', 'NirmalaB.ttf');
  return {
    regular,
    bold,
    ...(fs.existsSync(malayalamRegularPath) ? { malayalamRegular: makeFilterPath('Nirmala.ttf') } : {}),
    ...(fs.existsSync(malayalamBoldPath) ? { malayalamBold: makeFilterPath('NirmalaB.ttf') } : {}),
  };
});

ipcMain.handle('save-project', async (_event, content) => {
  if (typeof content !== 'string') return { error: 'Invalid project data.' };
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save FrameForge project',
    defaultPath: 'Untitled Project.ffproj',
    filters: [{ name: 'FrameForge Project', extensions: ['ffproj'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { filePath };
  } catch (error) {
    return { error: error.message };
  }
});

ipcMain.handle('open-project', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Open FrameForge project',
    properties: ['openFile'],
    filters: [{ name: 'FrameForge Project', extensions: ['ffproj', 'json'] }],
  });
  if (canceled || !filePaths.length) return { canceled: true };
  try {
    return { content: fs.readFileSync(filePaths[0], 'utf8'), filePath: filePaths[0] };
  } catch (error) {
    return { error: error.message };
  }
});


function executablePath(envName, fallbackName) {
  if (process.env[envName]) return process.env[envName];
  if (fallbackName === 'ffprobe' && process.env.FFMPEG_PATH && path.isAbsolute(process.env.FFMPEG_PATH)) {
    const sibling = path.join(path.dirname(process.env.FFMPEG_PATH), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(sibling)) return sibling;
  }
  return fallbackName;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new Error('Invalid file data received from the editor.');
}

function safeTempName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_.-]{1,120}$/.test(name) || name.includes('..')) {
    throw new Error('Invalid temporary filename in render request.');
  }
  return name;
}

function runCapture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

ipcMain.handle('probe-media-audio', async (_event, payload = {}) => {
  const items = Array.isArray(payload.assets) ? payload.assets : [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frameforge-probe-'));
  const audioAssetIds = [];
  try {
    for (const item of items) {
      if (!item || typeof item.id !== 'string') continue;
      const extension = String(path.extname(String(item.name || 'media.mp4'))).replace(/[^.a-z0-9]/gi, '') || '.mp4';
      const fileName = safeTempName(`probe-${audioAssetIds.length}-${Date.now()}${extension}`);
      const filePath = path.join(tempDir, fileName);
      fs.writeFileSync(filePath, toBuffer(item.bytes));
      try {
        const probe = await runCapture(executablePath('FFPROBE_PATH', 'ffprobe'), [
          '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', fileName,
        ], tempDir);
        if (probe.code === 0 && probe.stdout.toLowerCase().includes('audio')) audioAssetIds.push(item.id);
        if (probe.code !== 0 && /not recognized|enoent|spawn/i.test(probe.stderr)) {
          return { error: 'FFprobe was not found. Install FFmpeg (including FFprobe) and add its bin folder to PATH, or set FFPROBE_PATH.' };
        }
      } finally {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
    return { audioAssetIds };
  } catch (error) {
    return { error: `Could not inspect source audio: ${error.message}` };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

ipcMain.handle('export-timeline', async (event, payload = {}) => {
  const files = Array.isArray(payload.files) ? payload.files : [];
  const args = Array.isArray(payload.args) ? payload.args : [];
  const duration = Number(payload.duration);
  if (!files.length || !args.length || !Number.isFinite(duration) || duration <= 0 || duration > 24 * 60 * 60) {
    return { error: 'Invalid timeline render request.' };
  }
  if (args.length > 20000 || args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) || args[args.length - 1] !== '__FRAMEFORGE_OUTPUT__') {
    return { error: 'The timeline render plan is invalid or too large.' };
  }

  const safeProjectName = String(payload.projectName || 'FrameForge').replace(/[^a-z0-9-_ ]/gi, '').trim().slice(0, 80) || 'FrameForge';
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export FrameForge timeline',
    defaultPath: `${safeProjectName}.mp4`,
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });
  if (canceled || !filePath) return { canceled: true };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frameforge-render-'));
  try {
    const knownFiles = new Set();
    for (const item of files) {
      const name = safeTempName(item?.name);
      if (knownFiles.has(name)) throw new Error(`Duplicate render file: ${name}`);
      knownFiles.add(name);
      const target = path.join(tempDir, name);
      if (typeof item.data === 'string') fs.writeFileSync(target, item.data, 'utf8');
      else fs.writeFileSync(target, toBuffer(item.data));
    }
    // Every -i input must be one of the files created in this isolated temp directory.
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] === '-i') {
        const inputName = args[index + 1];
        if (!knownFiles.has(inputName)) throw new Error(`Render input is missing: ${inputName}`);
      }
    }
    // drawtext text files are also restricted to known files. The graph is passed as an argv value, never through a shell.
    const graphIndex = args.indexOf('-filter_complex');
    if (graphIndex < 0 || typeof args[graphIndex + 1] !== 'string') throw new Error('The render plan has no FFmpeg filter graph.');
    const graph = args[graphIndex + 1];
    for (const match of graph.matchAll(/textfile='([^']+)'/g)) {
      if (!knownFiles.has(match[1])) throw new Error(`Text overlay file is missing: ${match[1]}`);
    }

    const ffmpegArgs = ['-progress', 'pipe:1', '-nostats', ...args.slice(0, -1), filePath];
    const child = spawn(executablePath('FFMPEG_PATH', 'ffmpeg'), ffmpegArgs, { cwd: tempDir, windowsHide: true });
    let stderr = '';
    let progressBuffer = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk) => {
      progressBuffer += chunk.toString();
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('out_time_ms=')) {
          const microseconds = Number(line.slice('out_time_ms='.length));
          if (Number.isFinite(microseconds)) {
            const percent = Math.max(0, Math.min(99, Math.round((microseconds / 1000000 / duration) * 100)));
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) win.webContents.send('render-progress', percent);
            }
          }
        }
      }
    });
    const result = await new Promise((resolve) => {
      child.on('error', (error) => resolve({ code: -1, error: error.message }));
      child.on('close', (code) => resolve({ code, error: null }));
    });
    if (result.code !== 0) {
      if (result.code === -1) return { error: `Could not start FFmpeg. Install FFmpeg and add it to PATH, or set FFMPEG_PATH. ${result.error || ''}` };
      return { error: stderr.slice(-5000) || `FFmpeg exited with code ${result.code}.` };
    }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('render-progress', 100);
    }
    return { filePath };
  } catch (error) {
    return { error: error.message || String(error) };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

ipcMain.handle('save-export', async (_event, payload = {}) => {
  const { bytes, extension, start, duration, kind = 'video' } = payload;
  const speed = Math.max(0.5, Math.min(2, Number(payload.speed) || 1));
  const volume = Math.max(0, Math.min(2, Number(payload.volume) || 0));
  const brightness = Math.max(-50, Math.min(50, Number(payload.brightness) || 0));
  const contrast = Math.max(50, Math.min(150, Number(payload.contrast) || 100));
  const saturation = Math.max(0, Math.min(200, Number(payload.saturation) || 100));
  const presets = {
    none: '',
    cinematic: 'eq=contrast=1.12:saturation=0.88',
    vivid: 'eq=contrast=1.08:saturation=1.35',
    mono: 'hue=s=0',
    warm: 'colorbalance=rs=0.05:gs=0.02:bs=-0.03',
    cool: 'colorbalance=rs=-0.03:gs=0.01:bs=0.05',
    vintage: 'eq=contrast=0.92:saturation=0.75:brightness=0.02',
    noir: 'hue=s=0,eq=contrast=1.3',
  };
  if (!(bytes instanceof Uint8Array) && !Buffer.isBuffer(bytes) && !Array.isArray(bytes)) return { error: 'Invalid media data.' };
  if (!Number.isFinite(Number(start)) || !Number.isFinite(Number(duration)) || Number(duration) <= 0) return { error: 'Invalid trim range.' };

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export selected clip',
    defaultPath: 'frameforge-clip-export.mp4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  const safeExtension = String(extension || 'mp4').replace(/[^a-z0-9]/gi, '') || 'mp4';
  const inputPath = path.join(os.tmpdir(), `frameforge-input-${Date.now()}.${safeExtension}`);
  fs.writeFileSync(inputPath, Buffer.from(bytes));

  const eq = `eq=brightness=${brightness / 100}:contrast=${contrast / 100}:saturation=${saturation / 100}`;
  const vf = [`setpts=PTS/${speed}`, presets[payload.filter] || '', eq].filter(Boolean).join(',');
  const af = [`atempo=${speed}`, `volume=${volume}`].join(',');
  const args = ['-y', '-ss', String(start), '-i', inputPath, '-t', String(duration)];
  if (kind === 'video') args.push('-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '20');
  else args.push('-vn');
  args.push('-af', af, '-c:a', 'aac', '-movflags', '+faststart', filePath);

  return new Promise((resolve) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    child.on('close', (code) => {
      try { fs.unlinkSync(inputPath); } catch {}
      resolve(code === 0 ? { filePath } : { error: stderr.slice(-1800) || `FFmpeg exited with code ${code}.` });
    });
    child.on('error', (error) => {
      try { fs.unlinkSync(inputPath); } catch {}
      resolve({ error: `Install FFmpeg and add it to PATH. ${error.message}` });
    });
  });
});
