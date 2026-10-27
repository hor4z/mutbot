/**
 * Chat de Capitan: lo que llega (público, party, guild, susurros y avisos del server) y una caja para hablar con su nombre. El bot manda un mensaje
 * cada 2,5 s como mucho y corta en 60 bytes; si no puede, contesta por qué (sale en el aviso de arriba).
 */
import { Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatChannel, ChatEntry, PanelCommand } from "@mubot/protocol";
import { Button, cn } from "./components";

const KIND_LABEL: Record<ChatEntry["kind"], string> = { normal: "", party: "Party", guild: "Guild", whisper: "Susurro", server: "Server" };
const KIND_TONE: Record<ChatEntry["kind"], string> = { normal: "", party: "text-info", guild: "text-success", whisper: "text-warning", server: "text-faint" };
const hhmm = (t: number) => new Date(t).toTimeString().slice(0, 5);

export function Chat({ lines, onSay, disabled }: { lines: ChatEntry[]; onSay: (c: Extract<PanelCommand, { cmd: "say" }>) => void; disabled: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const [channel, setChannel] = useState<ChatChannel>("normal");
  const [showServer, setShowServer] = useState(true);
  const shown = showServer ? lines : lines.filter((l) => l.kind !== "server");
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || disabled) return;
    onSay({ cmd: "say", text: t, ...(to.trim() ? { to: to.trim() } : { channel }) });
    setText("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5">
      <label className="flex items-center gap-1.5 text-xs text-faint">
        <input type="checkbox" checked={showServer} onChange={(e) => setShowServer(e.target.checked)} />
        Mostrar avisos del server
      </label>
      <div
        ref={box}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {shown.map((l, i) => (
          <p key={`${l.at}-${i}`} className={cn("border-t border-line py-1 break-words first:border-t-0", KIND_TONE[l.kind], l.mine && "font-medium")}>
            <time className="mr-2 font-mono text-xs text-faint">{hhmm(l.at)}</time>
            {KIND_LABEL[l.kind] && <b className="mr-1.5 font-mono text-[10.5px] uppercase">{KIND_LABEL[l.kind]}</b>}
            {l.from && <b className="mr-1.5 font-medium">{l.from}:</b>}
            {l.text}
          </p>
        ))}
        {!shown.length && <p className="py-3 text-faint">Todavía no llegó nada del chat.</p>}
      </div>
      <form className="flex flex-col gap-1.5" onSubmit={submit}>
        <div className="flex gap-1.5">
          <select
            className="rounded-md border border-line bg-paper px-1.5 py-1 text-sm disabled:opacity-50"
            aria-label="Canal"
            value={channel}
            disabled={!!to.trim()}
            onChange={(e) => setChannel(e.target.value as ChatChannel)}
          >
            <option value="normal">Público</option>
            <option value="party">Party</option>
            <option value="guild">Guild</option>
          </select>
          <input
            className="w-28 rounded-md border border-line bg-paper px-2 py-1 text-sm"
            aria-label="Susurrar a"
            placeholder="Susurrar a…"
            maxLength={10}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="flex gap-1.5">
          <input
            className="min-w-0 flex-1 rounded-md border border-line bg-paper px-2 py-1.5 text-sm"
            aria-label="Mensaje"
            placeholder="Escribí como Capitan (máx. 60)"
            maxLength={60}
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" variant="primary" disabled={disabled || !text.trim()}>
            <Send size={13} /> Enviar
          </Button>
        </div>
      </form>
    </div>
  );
}
