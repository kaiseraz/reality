import React from 'react';
import type RFB from '@novnc/novnc';
import { Icon } from '../ui/Icon.tsx';

type State = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

/**
 * A bot's live desktop, native noVNC: one connection whose canvas moves between the
 * panel and the big take-over view, so switching never reconnects. Watching is view-only;
 * with control the mouse and keyboard go to the desktop (the bot is paused meanwhile).
 */
export function ComputerScreen({
  botId,
  name,
  control,
  onTakeover,
  onHandBack,
  onLeaveControl,
  lean = false,
}: {
  botId: string;
  name: string;
  /** The person holds the desktop (the bot is paused server-side). */
  control: boolean;
  onTakeover: () => void;
  onHandBack: (note: string) => void;
  /** Give control up without a note (stay paused is not offered in the panel view). */
  onLeaveControl: () => void;
  /** Lean (in the workbench): one slim toolbar, no extra buttons or text below. */
  lean?: boolean;
}) {
  // One VNC connection draws into one element that is moved between the panel
  // and the take-over view, so switching never reconnects.
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const clientRef = React.useRef<RFB | null>(null);
  const attemptRef = React.useRef(0);
  const retriesRef = React.useRef(0);
  const [state, setState] = React.useState<State>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [panelSlot, setPanelSlot] = React.useState<HTMLDivElement | null>(null);
  const [overlaySlot, setOverlaySlot] = React.useState<HTMLDivElement | null>(null);
  const [note, setNote] = React.useState('');
  // Watching in the large view, without taking control.
  const [expanded, setExpanded] = React.useState(false);
  const big = control || expanded;

  const canvas = React.useCallback(() => {
    if (!containerRef.current) {
      containerRef.current = document.createElement('div');
      containerRef.current.className = 'vnc-canvas';
    }
    return containerRef.current;
  }, []);

  const connect = React.useCallback(async () => {
    const attempt = ++attemptRef.current;
    clientRef.current?.disconnect();
    clientRef.current = null;
    setState('connecting');
    setError(null);
    try {
      const typeMod = await import('@novnc/novnc');
      const Client: new (
        target: HTMLElement,
        url: string,
        options?: Record<string, unknown>,
      ) => RFB = (typeMod as { default: typeof typeMod.default }).default;
      if (attempt !== attemptRef.current) return;
      const target = canvas();
      target.replaceChildren();
      const rfb = new Client(target, `/api/bots/${botId}/computer/screen/websockify`, {});
      rfb.scaleViewport = true;
      rfb.background = 'transparent';
      rfb.viewOnly = true;
      // Balanced for a live watch: sharp enough to read, light enough not to lag.
      try {
        rfb.qualityLevel = 6;
        rfb.compressionLevel = 2;
      } catch {
        // Older builds without these knobs still stream fine.
      }
      rfb.addEventListener('connect', () => {
        retriesRef.current = 0;
        if (attempt === attemptRef.current) setState('connected');
      });
      rfb.addEventListener('disconnect', () => {
        if (attempt !== attemptRef.current) return;
        clientRef.current = null;
        setState('disconnected');
      });
      clientRef.current = rfb;
    } catch (cause) {
      if (attempt !== attemptRef.current) return;
      setState('error');
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [botId, canvas]);

  // Put the live screen wherever it is being shown.
  React.useLayoutEffect(() => {
    const slot = big && overlaySlot ? overlaySlot : panelSlot;
    if (slot && canvas().parentElement !== slot) slot.appendChild(canvas());
  }, [big, overlaySlot, panelSlot, canvas]);

  // The large view connects too, if the stream is not up yet — and watching with
  // nothing clicked is the point of the panel, so connect on appearance.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the connect state change is the point of the call
    if (state === 'idle') void connect();
  }, [state, connect]);

  // A dropped stream reconnects by itself. A freshly started computer needs a
  // while before its desktop answers (the computer already counts as "running"
  // while it still boots), so five quick tries used to give up long before the
  // picture arrived and the screen sat on "disconnected" until a manual click.
  // Keep trying with a capped backoff; the panel above unmounts this screen
  // when the computer is really off, which stops the loop.
  React.useEffect(() => {
    if (state !== 'disconnected' && state !== 'error') return;
    if (retriesRef.current >= 60) return;
    retriesRef.current += 1;
    const t = setTimeout(() => void connect(), Math.min(1500 * retriesRef.current, 5000));
    return () => clearTimeout(t);
  }, [state, connect]);

  // Taking over holds the bot server-side, connects if needed, un-mutes input.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- same, takeover connects on demand
    if (control && (state === 'idle' || state === 'disconnected')) void connect();
    const rfb = clientRef.current;
    if (!rfb) return;
    rfb.viewOnly = !control;
    if (control) rfb.focus();
  }, [control, state, connect]);

  React.useEffect(
    () => () => {
      attemptRef.current += 1;
      clientRef.current?.disconnect();
      clientRef.current = null;
    },
    [],
  );

  const live = state === 'connected';
  const label = control ? 'you have control' : live ? 'watching' : state;

  return (
    <div className="vnc-space">
      <div className="vnc-head small">
        <span className={`dot ${live ? 'tone-ok live' : control ? 'tone-warn' : ''}`} />
        <span className="mono">Live desktop · {label}</span>
        <span className="grow" />
        {((lean ? state !== 'connected' : live) ||
          state === 'disconnected' ||
          state === 'error') && (
          <button
            className="btn-ghost small"
            aria-label="Reconnect the live screen"
            onClick={() => void connect()}
          >
            <Icon name="undo" size={13} /> Reconnect
          </button>
        )}
        {live && !control && (
          <button className="btn-ghost small" onClick={() => setExpanded(true)}>
            <Icon name="monitor" size={13} /> Big
          </button>
        )}
        {live && !control && lean && (
          <button className="btn-ghost small" onClick={onTakeover}>
            <Icon name="command" size={13} /> Take over
          </button>
        )}
      </div>

      <div className="vnc-frame">
        <div ref={setPanelSlot} className="vnc-slot" />
        {!live && (
          <div className="vnc-quiet">
            {state === 'connecting' ? (
              <span className="mono">starting desktop…</span>
            ) : state === 'error' ? (
              <p className="callout tone-bad small">{error}</p>
            ) : (
              <button className="btn-ghost small" onClick={() => void connect()}>
                <Icon name="play" size={13} /> {state === 'disconnected' ? 'Reconnect' : 'Connect'}
              </button>
            )}
          </div>
        )}
      </div>

      {!lean && live && !control && (
        <button className="btn-primary small vnc-take" onClick={onTakeover}>
          <Icon name="command" size={14} /> Take over — pause {name}
        </button>
      )}
      {!lean && (
        <p className="muted small">
          Take over pauses {name} and gives you its mouse and keyboard — sign in, pay or fix
          something, then hand it back with a note and it carries on.
        </p>
      )}

      {big && (
        <div className="vnc-overlay" role="dialog" aria-label={`${name}'s desktop, large`}>
          <div className="vnc-overlay-head">
            <span className={`dot ${live ? 'tone-ok' : 'tone-warn'}`} />
            <strong>
              {control ? `You have control of ${name}'s computer` : `${name}'s computer`}
            </strong>
            <span className="muted small">
              {control
                ? `${name} is paused · your mouse and keyboard go to the desktop`
                : 'watching live · view only'}
            </span>
            <span className="grow" />
            {!control && (
              <button className="btn-ghost small" onClick={onTakeover}>
                <Icon name="command" size={14} /> Take over
              </button>
            )}
            <button
              className="btn-ghost small"
              onClick={control ? onLeaveControl : () => setExpanded(false)}
            >
              <Icon name="x" size={13} /> {control ? 'Stop control' : 'Close'}
            </button>
          </div>
          <div className="vnc-overlay-frame">
            <div ref={setOverlaySlot} className="vnc-slot" />
            {!live && (
              <div className="vnc-quiet">
                <span className="mono">connecting…</span>
              </div>
            )}
          </div>
          {control && (
            <form
              className="vnc-handback"
              onSubmit={(e) => {
                e.preventDefault();
                onHandBack(note.trim());
                setNote('');
              }}
            >
              <textarea
                className="grow"
                rows={1}
                placeholder={`Anything ${name} should know? e.g. "Logged in — pick the 6:15 flight" (optional)`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button type="button" className="btn-ghost small" onClick={onLeaveControl}>
                Stay paused
              </button>
              <button type="submit" className="btn-primary small">
                <Icon name="undo" size={14} /> Hand back
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
