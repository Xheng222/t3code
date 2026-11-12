import {
  Component,
  createContext,
  createRef,
  use,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { useStableCallback } from "~/hooks/useStableCallback";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { createTimelineLayout } from "./timelineLayout.fork";

type TimelineMotion = ReturnType<typeof createTimelineLayout>;
const MotionRowContext = createContext<{
  motion: TimelineMotion;
  id: string;
  closingChildren: boolean;
} | null>(null);

function retainDepartures(
  previous: readonly MessagesTimelineRow[],
  next: readonly MessagesTimelineRow[],
) {
  const nextIds = new Set(next.map((row) => row.id));
  const exits = new Set<string>();
  const before = new Map<string, MessagesTimelineRow[]>();
  let pending: MessagesTimelineRow[] = [];
  for (const row of previous) {
    if (nextIds.has(row.id)) {
      if (pending.length > 0) before.set(row.id, pending);
      pending = [];
    } else {
      pending.push(row);
      exits.add(row.id);
    }
  }
  return {
    rows: [...next.flatMap((row) => [...(before.get(row.id) ?? []), row]), ...pending],
    exits,
  };
}

export function useTimelineMotionRows(
  source: MessagesTimelineRow[],
  identity: string,
  animate: boolean,
) {
  const [state, setState] = useState({
    identity,
    source,
    rows: source,
    exits: new Set<string>(),
    prepended: false,
  });
  if (
    state.identity !== identity ||
    state.source !== source ||
    (!animate && state.exits.size > 0)
  ) {
    const first = state.source[0]?.id;
    const prepended =
      state.identity === identity &&
      first !== undefined &&
      source[0]?.id !== first &&
      source.some((row) => row.id === first);
    const retained =
      state.identity === identity && animate && !prepended
        ? retainDepartures(state.rows, source)
        : { rows: source, exits: new Set<string>() };
    setState({ identity, source, ...retained, prepended });
  }
  const [pins, setPins] = useState<ReadonlySet<string>>(() => new Set());
  const isEnabled = useStableCallback(
    () => animate && !state.prepended && document.visibilityState === "visible",
  );
  const onExited = useStableCallback((ids: ReadonlySet<string>) => {
    setState((current) => {
      if (![...ids].some((id) => current.exits.has(id))) return current;
      return {
        ...current,
        rows: current.rows.filter((row) => !ids.has(row.id) || !current.exits.has(row.id)),
        exits: new Set([...current.exits].filter((id) => !ids.has(id))),
      };
    });
  });
  const onPins = useStableCallback((ids: ReadonlySet<string>) =>
    setPins((current) =>
      current.size === ids.size && [...current].every((id) => ids.has(id)) ? current : ids,
    ),
  );
  const [motion] = useState(() => createTimelineLayout({ animate: isEnabled, onExited, onPins }));
  const committedIdentity = useRef(identity);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed virtual row structure to the DOM layout coordinator
  useLayoutEffect(() => {
    const changed = committedIdentity.current !== identity;
    committedIdentity.current = identity;
    motion.setRows(state.rows, source, state.exits, changed);
  }, [motion, state.rows, state.exits, source, committedIdentity, identity]);
  const closingGroups = new Set(
    state.rows.flatMap((row) =>
      row.kind === "work" && row.groupId && state.exits.has(row.id) ? [row.groupId] : [],
    ),
  );
  return {
    motion,
    rows: state.rows,
    exits: state.exits,
    pins,
    closingGroups,
    prepended: state.prepended,
  };
}

type RowProps = {
  entry: MessagesTimelineRow;
  motion: TimelineMotion;
  id: string;
  exiting: boolean;
  presentationPending: boolean;
  closingChildren?: boolean;
  children: ReactNode;
};

export class TimelineMotionRow extends Component<RowProps> {
  private readonly element = createRef<HTMLDivElement>();
  private readonly content = createRef<HTMLDivElement>();
  private detach: (() => void) | undefined;

  override componentDidMount() {
    this.register();
  }
  override getSnapshotBeforeUpdate(previous: RowProps) {
    if (
      previous.entry !== this.props.entry ||
      previous.presentationPending !== this.props.presentationPending
    )
      this.props.motion.capture(
        this.props.presentationPending ||
          (this.props.entry.kind === "message" && this.props.entry.message.streaming)
          ? undefined
          : this.props.id,
      );
    return null;
  }
  override componentDidUpdate(previous: RowProps) {
    if (previous.id !== this.props.id || previous.motion !== this.props.motion) {
      this.detach?.();
      this.register();
    }
    this.props.motion.layoutChanged();
  }
  override componentWillUnmount() {
    this.detach?.();
  }
  private register() {
    if (this.element.current && this.content.current)
      this.detach = this.props.motion.register(
        this.props.id,
        this.element.current,
        this.content.current,
      );
  }
  override render() {
    const { motion, id, exiting, closingChildren = false, children } = this.props;
    return (
      <MotionRowContext value={{ motion, id, closingChildren }}>
        <div
          ref={this.element}
          data-timeline-motion-row={id}
          data-timeline-streaming={
            this.props.presentationPending ||
            (this.props.entry.kind === "message" && Boolean(this.props.entry.message.streaming))
          }
          inert={exiting || undefined}
          aria-hidden={exiting || undefined}
        >
          <div ref={this.content} className="flow-root">
            {children}
          </div>
        </div>
      </MotionRowContext>
    );
  }
}

export function useClosingMotionChildren() {
  return use(MotionRowContext)?.closingChildren ?? false;
}

const subscribeNothing = () => () => {};

/** Whether row heights are animating or have just settled; rows that pass `false` never rerender for it. */
export function useTimelineSettling(enabled: boolean) {
  const motion = use(MotionRowContext)?.motion;
  return useSyncExternalStore(
    enabled && motion ? motion.subscribeSettling : subscribeNothing,
    () => enabled && motion !== undefined && motion.isSettling(),
  );
}

export function useTimelineResize() {
  const row = use(MotionRowContext);
  return () => {
    if (row) row.motion.capture(row.id);
  };
}

export function TimelineDisclosureIndicator({
  expanded,
  className,
}: {
  expanded: boolean;
  className?: string;
}) {
  const motion = use(MotionRowContext)?.motion;
  const element = useRef<SVGSVGElement | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the mounted SVG with the imperative region animator
  useLayoutEffect(() => {
    if (element.current) return motion?.registerIndicator(element.current);
  }, [motion]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shares the region animator's clock and interruption point with its disclosure indicator
  useLayoutEffect(() => {
    if (element.current) motion?.setIndicatorExpanded(element.current, expanded);
  }, [motion, expanded]);
  return (
    <ChevronRightIcon
      ref={element}
      aria-hidden
      data-expanded={expanded}
      className={cn("shrink-0 origin-center", className)}
      style={!motion ? { transform: `rotate(${expanded ? 90 : 0}deg)` } : undefined}
    />
  );
}

export function TimelineDisclosure({
  open,
  children,
  retainOnClose = true,
  measureOnly = false,
  slide = false,
}: {
  open: boolean;
  children: ReactNode;
  retainOnClose?: boolean;
  measureOnly?: boolean;
  /** Content that follows stays and slides up over this content as it closes. */
  slide?: boolean;
}) {
  const row = use(MotionRowContext);
  const [state, setState] = useState({ content: open ? children : null, present: open });
  if (open && (!state.present || state.content !== children))
    setState({ content: children, present: true });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- removes retained disclosure content only after the enclosing region reaches its collapsed geometry
  useLayoutEffect(() => {
    if (open || !state.present) return;
    const clear = () => setState({ content: null, present: false });
    if (!row || !retainOnClose) {
      clear();
      return;
    }
    return row.motion.afterSettled(clear);
  }, [open, state.present, row, retainOnClose]);
  if (!state.present || (!open && !retainOnClose)) return null;
  return (
    <div className="relative" data-motion-slide={!open && slide ? "" : undefined}>
      <div
        className="flow-root"
        data-motion-closing-body={!open ? "" : undefined}
        data-motion-preview-measure={measureOnly ? "" : undefined}
        style={
          measureOnly
            ? { position: "absolute", insetInline: 0, top: 0, visibility: "hidden" }
            : undefined
        }
        inert={!open || measureOnly || undefined}
        aria-hidden={!open || measureOnly || undefined}
      >
        {open ? children : state.content}
      </div>
    </div>
  );
}
