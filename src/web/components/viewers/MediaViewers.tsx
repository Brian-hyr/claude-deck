// Visualizadores de mídia: imagem, vídeo, áudio (com forma de onda), PDF, HTML, CSV e binário.
import { useEffect, useRef, useState } from 'preact/hooks';
import { rpc } from '../../lib/rpc';
import { rawUrl, type FileTab, errorText, platformOf, workspace } from '../../lib/state';
import { formatBytes, formatDuration } from '../../lib/format';
import { Icon } from '../icons';
import { basename, dirname, relativeTo } from '../../../shared/paths';

/** Props dos visualizadores: `rk` muda quando o arquivo é recarregado do disco. */
type ViewerProps = { f: FileTab; rk?: number };

export function ImageViewer({ f }: ViewerProps) {
  const [zoom, setZoom] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [err, setErr] = useState(false);
  const src = `${rawUrl(f.hostId, f.path)}&v=${f.mtime}`;
  if (err)
    return (
      <div class="viewer-center">
        <Icon name="file-media" style={{ fontSize: 40 }} />
        Não consegui mostrar esta imagem (formato não suportado pelo navegador?).
      </div>
    );
  return (
    <>
      <div class={`image-view checker${zoom ? ' zoomed' : ''}${dims && dims.w < 64 ? ' pixel' : ''}`} onClick={() => setZoom(!zoom)} title={zoom ? 'Clique para ajustar à tela' : 'Clique para ver em 100%'}>
        <img
          src={src}
          style={zoom ? { maxWidth: 'none' } : { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          onLoad={(e) => {
            const im = e.target as HTMLImageElement;
            setDims({ w: im.naturalWidth, h: im.naturalHeight });
          }}
          onError={() => setErr(true)}
        />
      </div>
      {dims && (
        <div style={{ position: 'absolute', right: 10, bottom: 8, fontSize: 11, background: 'var(--bg-widget)', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--border)' }}>
          {dims.w}×{dims.h} · {formatBytes(f.size)}
        </div>
      )}
    </>
  );
}

export function VideoViewer({ f }: ViewerProps) {
  const [err, setErr] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ w: number; h: number; d: number } | null>(null);
  const src = `${rawUrl(f.hostId, f.path)}&v=${f.mtime}`;
  return (
    <div class="media-view">
      {err ? (
        <div class="viewer-center" style={{ color: '#ccc' }}>
          <Icon name="device-camera-video" style={{ fontSize: 40 }} />
          <div>{err}</div>
          <a href={rawUrl(f.hostId, f.path, true)} class="btn secondary">
            <Icon name="cloud-download" /> Baixar o vídeo
          </a>
        </div>
      ) : (
        <video
          src={src}
          controls
          preload="metadata"
          onLoadedMetadata={(e) => {
            const v = e.target as HTMLVideoElement;
            setMeta({ w: v.videoWidth, h: v.videoHeight, d: v.duration });
          }}
          onError={() => setErr('O navegador não conseguiu reproduzir este vídeo (codec não suportado — MP4 com H.264 e WebM funcionam).')}
        />
      )}
      {meta && !err && (
        <div style={{ position: 'absolute', right: 10, top: 8, fontSize: 11, color: '#ddd', background: 'rgba(0,0,0,.55)', padding: '2px 8px', borderRadius: 4 }}>
          {meta.w}×{meta.h} · {Number.isFinite(meta.d) ? formatDuration(Math.round(meta.d * 1000)) : ''} · {formatBytes(f.size)}
        </div>
      )}
    </div>
  );
}

/**
 * Taxa de amostragem, canais e bits lidos do cabeçalho do arquivo (WAV, FLAC, MP3, Ogg).
 * O decodeAudioData do navegador reamostra para a taxa da placa de som (ex.: 48 kHz),
 * então a taxa real do arquivo só sai daqui.
 */
export function sniffAudio(buf: ArrayBuffer): { sr?: number; ch?: number; bits?: number } {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  const str = (o: number, n: number) => (o + n <= b.length ? String.fromCharCode(...b.subarray(o, o + n)) : '');
  try {
    if (str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE') {
      let o = 12;
      while (o + 8 <= b.length) {
        const size = dv.getUint32(o + 4, true);
        if (str(o, 4) === 'fmt ' && o + 24 <= b.length) return { ch: dv.getUint16(o + 10, true), sr: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
        o += 8 + size + (size & 1);
      }
      return {};
    }
    if (str(0, 4) === 'fLaC' && b.length >= 22) {
      const o = 18; // "fLaC" + cabeçalho do bloco (4) + 10 bytes de tamanhos do STREAMINFO
      return { sr: (b[o] << 12) | (b[o + 1] << 4) | (b[o + 2] >> 4), ch: ((b[o + 2] >> 1) & 7) + 1, bits: (((b[o + 2] & 1) << 4) | (b[o + 3] >> 4)) + 1 };
    }
    if (str(0, 4) === 'OggS') {
      const head = String.fromCharCode(...b.subarray(0, Math.min(b.length, 512)));
      const v = head.indexOf('\x01vorbis');
      if (v >= 0 && v + 16 <= b.length) return { ch: b[v + 11], sr: dv.getUint32(v + 12, true) };
      const op = head.indexOf('OpusHead');
      if (op >= 0 && op + 16 <= b.length) return { ch: b[op + 9], sr: dv.getUint32(op + 12, true) || 48000 };
      return {};
    }
    // MP3: pula a etiqueta ID3v2 e lê o primeiro quadro válido.
    let o = 0;
    if (str(0, 3) === 'ID3' && b.length > 10) o = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
    for (let i = o; i < Math.min(b.length - 4, o + 64 * 1024); i++) {
      if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
      const ver = (b[i + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
      const layer = (b[i + 1] >> 1) & 3;
      const srIdx = (b[i + 2] >> 2) & 3;
      const brIdx = b[i + 2] >> 4;
      if (ver === 1 || layer === 0 || srIdx === 3 || brIdx === 15 || brIdx === 0) continue;
      const base = [44100, 48000, 32000][srIdx];
      return { sr: ver === 3 ? base : ver === 2 ? base / 2 : base / 4, ch: b[i + 3] >> 6 === 3 ? 1 : 2 };
    }
  } catch {
    /* cabeçalho estranho: sem informação */
  }
  return {};
}

export function AudioViewer({ f }: ViewerProps) {
  const src = `${rawUrl(f.hostId, f.path)}&v=${f.mtime}`;
  const audio = useRef<HTMLAudioElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [info, setInfo] = useState<{ sr?: number; ch?: number; bits?: number; d?: number } | null>(null);
  const [waveErr, setWaveErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [t, setT] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPeaks(null);
    setWaveErr(null);
    setInfo(null);
    (async () => {
      try {
        if (f.size > 80 * 1024 * 1024) {
          // Arquivo grande: só o cabeçalho (para taxa/canais), sem forma de onda.
          const head = await (await fetch(src, { headers: { range: 'bytes=0-131071' } })).arrayBuffer();
          if (!cancelled) setInfo(sniffAudio(head));
          if (!cancelled) setWaveErr('Arquivo grande: forma de onda desativada.');
          return;
        }
        const buf = await (await fetch(src)).arrayBuffer();
        const header = sniffAudio(buf); // antes de decodificar (o decode "consome" o buffer)
        const Ctx = window.AudioContext || (window as any).webkitAudioContext;
        const ctx: AudioContext = new Ctx();
        const decoded = await ctx.decodeAudioData(buf);
        ctx.close();
        if (cancelled) return;
        const N = 1200;
        const ch0 = decoded.getChannelData(0);
        const ch1 = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : null;
        const step = Math.max(1, Math.floor(ch0.length / N));
        const p = new Float32Array(N);
        let top = 0;
        for (let i = 0; i < N; i++) {
          let max = 0;
          const start = i * step;
          for (let j = start; j < start + step && j < ch0.length; j += 4) {
            const a = Math.abs(ch0[j]);
            const b = ch1 ? Math.abs(ch1[j]) : 0;
            if (a > max) max = a;
            if (b > max) max = b;
          }
          p[i] = max;
          if (max > top) top = max;
        }
        // Normaliza (gravações baixas ficam visíveis), sem exagerar o ruído de fundo.
        const gain = top > 0 ? Math.min(1 / top, 12) * 0.95 : 1;
        for (let i = 0; i < N; i++) p[i] = Math.min(1, p[i] * gain);
        setPeaks(p);
        setInfo({ sr: header.sr ?? decoded.sampleRate, ch: header.ch ?? decoded.numberOfChannels, bits: header.bits, d: decoded.duration });
      } catch (e) {
        if (!cancelled) setWaveErr(`Sem forma de onda: ${errorText(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const g = cv.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const d = info?.d || (Number.isFinite(audio.current?.duration) ? audio.current!.duration : 0) || 1;
    const progress = Math.min(1, t / d);
    const styles = getComputedStyle(document.documentElement);
    const played = styles.getPropertyValue('--accent').trim() || '#0078d4';
    const rest = styles.getPropertyValue('--fg-faint').trim() || '#777';
    const n = peaks.length;
    const barW = w / n;
    for (let i = 0; i < n; i++) {
      const x = i * barW;
      const amp = Math.max(1, peaks[i] * (h / 2 - 4));
      g.fillStyle = i / n <= progress ? played : rest;
      g.fillRect(x, h / 2 - amp, Math.max(1, barW - 0.4), amp * 2);
    }
  }, [peaks, t, info]);

  const seek = (e: MouseEvent) => {
    const a = audio.current;
    const cv = canvas.current;
    if (!a || !cv || !Number.isFinite(a.duration)) return;
    const r = cv.getBoundingClientRect();
    a.currentTime = ((e.clientX - r.left) / r.width) * a.duration;
    a.play();
  };

  return (
    <div class="audio-view">
      <div class="audio-card">
        <div class="title">
          <Icon name="unmute" /> {f.name}
        </div>
        {peaks ? <canvas ref={canvas} class="waveform" onClick={seek as any} title="Clique para ir até esse ponto" /> : <div class="waveform" style={{ display: 'grid', placeItems: 'center', color: 'var(--fg-muted)', fontSize: 12 }}>{waveErr ?? 'Gerando forma de onda…'}</div>}
        {err ? (
          <div style={{ color: 'var(--err)', marginTop: 10 }}>{err}</div>
        ) : (
          <audio ref={audio} src={src} controls preload="metadata" onTimeUpdate={(e) => setT((e.target as HTMLAudioElement).currentTime)} onError={() => setErr('O navegador não reproduz este formato de áudio.')} />
        )}
        <div class="audio-meta" style={{ marginTop: 8 }}>
          {info?.d != null && <span>{formatDuration(Math.round(info.d * 1000))}</span>}
          {info?.sr != null && <span>{(info.sr / 1000).toFixed(info.sr % 1000 ? 1 : 0)} kHz</span>}
          {info?.bits != null && <span>{info.bits} bits</span>}
          {info?.ch != null && <span>{info.ch === 1 ? 'mono' : info.ch === 2 ? 'estéreo' : `${info.ch} canais`}</span>}
          <span>{formatBytes(f.size)}</span>
          <a href={rawUrl(f.hostId, f.path, true)}>Baixar</a>
        </div>
      </div>
    </div>
  );
}

export function PdfViewer({ f }: ViewerProps) {
  return <iframe class="pdf-frame" src={`${rawUrl(f.hostId, f.path)}&v=${f.mtime}`} title={f.name} />;
}

/**
 * HTML de verdade (com CSS/JS/imagens relativos), isolado num iframe sem acesso ao app.
 * A raiz servida é a pasta aberta no explorador (como o Live Preview do VS Code), para que
 * caminhos como "../imagens/x.png" funcionem; fora dela, a pasta do próprio arquivo.
 */
export function HtmlViewer({ f }: ViewerProps) {
  const [token, setToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const platform = platformOf(f.hostId);
  const ws = workspace.value;
  const inWs = ws && ws.hostId === f.hostId ? relativeTo(platform, ws.root, f.path) : null;
  const root = inWs ? ws!.root : dirname(platform, f.path);
  const rel = inWs || basename(f.path);
  useEffect(() => {
    setToken(null);
    rpc
      .call('fs.previewToken', { h: f.hostId, root })
      .then(setToken)
      .catch((e) => setErr(errorText(e)));
  }, [f.hostId, root]);
  if (err) return <div class="viewer-center">{err}</div>;
  if (!token) return <div class="tree-loading" />;
  const url = `/preview/${token}/${rel.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
  return (
    <>
      <iframe
        key={`${n}-${f.mtime}`}
        class="html-frame"
        src={url}
        sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
        title={f.name}
      />
      <div style={{ position: 'absolute', right: 10, bottom: 10, display: 'flex', gap: 6 }}>
        <button class="btn secondary" title="Recarregar" onClick={() => setN(n + 1)}>
          <Icon name="refresh" />
        </button>
        <a class="btn secondary" href={url} target="_blank" rel="noopener" title="Abrir numa janela separada">
          <Icon name="link-external" />
        </a>
      </div>
    </>
  );
}

function parseCsv(text: string, sep: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= maxRows) return rows;
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function CsvViewer({ f }: ViewerProps) {
  const first = f.content.slice(0, 5000);
  const sep = f.path.toLowerCase().endsWith('.tsv') ? '\t' : (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows = parseCsv(f.content, sep, 5001);
  const [head, ...body] = rows;
  return (
    <div class="fill">
      <table class="csv-table">
        <thead>
          <tr>
            <th class="rn">#</th>
            {(head ?? []).map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, 5000).map((r, i) => (
            <tr key={i}>
              <td class="rn">{i + 1}</td>
              {r.map((c, j) => (
                <td key={j} title={c.length > 60 ? c : undefined}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 5000 && <div class="tree-empty">Mostrando as primeiras 5.000 linhas.</div>}
    </div>
  );
}

export function BinaryViewer({ f }: ViewerProps) {
  const [hex, setHex] = useState<string | null>(null);
  useEffect(() => {
    rpc
      .call('fs.read', { h: f.hostId, p: f.path, max: 4096 })
      .then((r) => {
        const bytes = r.encoding === 'base64' ? Uint8Array.from(atob(r.content), (c) => c.charCodeAt(0)) : new TextEncoder().encode(r.content);
        const lines: string[] = [];
        for (let i = 0; i < bytes.length; i += 16) {
          const chunk = bytes.subarray(i, i + 16);
          const h = Array.from(chunk, (b) => b.toString(16).padStart(2, '0')).join(' ');
          const a = Array.from(chunk, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
          lines.push(`${i.toString(16).padStart(8, '0')}  ${h.padEnd(47)}  ${a}`);
        }
        setHex(lines.join('\n'));
      })
      .catch((e) => setHex(errorText(e)));
  }, [f.path, f.mtime]);
  return (
    <div class="fill">
      <div class="banner">
        <Icon name="file-binary" />
        <span class="grow">
          Arquivo binário ({formatBytes(f.size)}). Mostrando os primeiros 4 KB em hexadecimal.
        </span>
        <a class="btn secondary" href={rawUrl(f.hostId, f.path, true)}>
          <Icon name="cloud-download" /> Baixar
        </a>
      </div>
      <div class="hex">{hex ?? 'Carregando…'}</div>
    </div>
  );
}
