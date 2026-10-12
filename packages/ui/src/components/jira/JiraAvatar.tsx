import React from 'react';

/**
 * The issue rows' people and the issue's own type icon. The instance
 * serves each at its own image path — the server proxies them with the
 * token the browser never holds (GET /api/openchamber/jira/avatar) —
 * and while it loads, or when the path is missing or the image fails,
 * the circle Jira itself would fall back to: the initials of the display
 * name on a color that belongs to the name alone, so the same person
 * reads as the same color in every list.
 *
 * The image answers through three windows, and all three must land:
 * a cached avatar can complete before any listener exists (the ref
 * callback reads its own complete flag the moment the node appears), a
 * fresh one fires load once its bytes arrive (the handlers the same ref
 * attached), and a path change resets the verdict during the render
 * that swaps the src — no effect, because an effect runs after the ref
 * and would bury a synchronous verdict under a stale loading.
 */
export const JiraAvatar: React.FC<{
    name: string | null | undefined;
    imagePath?: string | null;
    className?: string;
}> = ({ name, imagePath, className }) => {
    const trimmed = name?.trim() ?? '';
    const initials = trimmed
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((word) => word.charAt(0).toUpperCase())
        .join('');
    // A stable hue per name: the letters decide, nothing random, so the
    // color survives re-renders and sessions.
    let hash = 0;
    for (let index = 0; index < trimmed.length; index += 1) {
        hash = (hash * 31 + trimmed.charCodeAt(index)) % 360;
    }
    const hue = hash === 0 ? 210 : hash;

    const avatarSrc = imagePath ? `/api/openchamber/jira/avatar?path=${encodeURIComponent(imagePath)}` : null;

    const [verdict, setVerdict] = React.useState<'loading' | 'ready' | 'failed'>('loading');
    const [seenSrc, setSeenSrc] = React.useState(avatarSrc);
    // A path change is a different person: reset during this render, so
    // the img that follows starts from an honest loading the same commit
    // its new src lands in.
    if (avatarSrc !== seenSrc) {
        setSeenSrc(avatarSrc);
        setVerdict('loading');
    }

    // Stable identity: React re-invokes it exactly when the img mounts
    // or unmounts — never on unrelated re-renders that could re-open a
    // verdict that already closed.
    const imageRef = React.useCallback((node: HTMLImageElement | null): void => {
        if (!node) return;
        if (node.complete) {
            setVerdict(node.naturalWidth > 0 ? 'ready' : 'failed');
            return;
        }
        node.onload = () => setVerdict('ready');
        node.onerror = () => setVerdict('failed');
    }, []);

    return (
        <span
            aria-hidden="true"
            className={`relative inline-flex size-5 shrink-0 select-none items-center justify-center overflow-hidden rounded-full text-[9px] font-semibold uppercase text-white ${className ?? ''}`}
            style={{ backgroundColor: `hsl(${hue} 45% 45%)` }}
        >
            {avatarSrc && verdict !== 'failed' ? (
                <img
                    ref={imageRef}
                    src={avatarSrc}
                    alt=""
                    className={`absolute inset-0 size-full object-cover ${verdict === 'ready' ? '' : 'opacity-0'}`}
                />
            ) : null}
            {verdict !== 'ready' ? initials || '·' : null}
        </span>
    );
};
