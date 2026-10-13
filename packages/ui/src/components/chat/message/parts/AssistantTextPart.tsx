import React from 'react';
import type { Part } from '@/lib/opencode/model';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import type { StreamPhase, ToolPopupContent } from '../types';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { resolveAssistantDisplayText, resolveAssistantTextStreaming, shouldRenderAssistantText } from './assistantTextVisibility';
import { streamPerfCount, streamPerfObserve } from '@/stores/utils/streamDebug';
import { GeneratedJsonResultCard } from './GeneratedJsonResultCard';
import { parseGeneratedJsonResult } from './generatedJsonResult';
import { splitTrailingJsonDigest } from './trailingJsonDigest';

type PartWithText = Part & { text?: string; content?: string; value?: string; time?: { start?: number; end?: number } };

// A streaming reply is read a block at a time (see streamTextCommit.ts); taking
// new text at most this often lets the blocks finished in between land, and
// move the chat, together.
const REPLY_REVEAL_INTERVAL_MS = 400;

interface AssistantTextPartProps {
    part: Part;
    sessionId?: string;
    messageId: string;
    streamPhase: StreamPhase;
    onShowPopup?: (content: ToolPopupContent) => void;
}

const AssistantTextPart: React.FC<AssistantTextPartProps> = ({
    part,
    messageId,
    streamPhase,
    onShowPopup,
}) => {
    // Use part directly from props — parent provides the latest version from the store.
    // No store subscription here to avoid re-render cascade from unrelated delta events.
    const partWithText = part as PartWithText;
    const { t } = useI18n();
    const rawText = typeof partWithText.text === 'string' ? partWithText.text : '';
    const contentText = typeof partWithText.content === 'string' ? partWithText.content : '';
    const valueText = typeof partWithText.value === 'string' ? partWithText.value : '';
    const textContent = [rawText, contentText, valueText].reduce((best, candidate) => {
        return candidate.length > best.length ? candidate : best;
    }, '');
    const time = partWithText.time;
    const isFinalized = Boolean(time && typeof time.end !== 'undefined');
    const isStreaming = resolveAssistantTextStreaming({
        streamPhase,
        isFinalized,
    });

    streamPerfCount('ui.assistant_text_part.render');
    if (isStreaming) {
        streamPerfCount('ui.assistant_text_part.render.streaming');
    }

    const throttledTextContent = useStreamingTextThrottle({
        text: textContent,
        isStreaming,
        throttleMs: REPLY_REVEAL_INTERVAL_MS,
        identityKey: `${messageId}:${part.id ?? 'text'}`,
    });

    const displayTextContent = resolveAssistantDisplayText({
        textContent,
        throttledTextContent,
        isStreaming,
    });

    streamPerfObserve('ui.assistant_text_part.display_len', displayTextContent.length);

    const isRenderableTextPart = part.type === 'text' || part.type === 'reasoning';
    if (!isRenderableTextPart) {
        return null;
    }

    if (!shouldRenderAssistantText({
        displayTextContent,
        isFinalized,
    })) {
        return null;
    }

    const generatedResult = !isStreaming && isFinalized ? parseGeneratedJsonResult(displayTextContent) : null;
    if (generatedResult) {
        return (
            <div
                className="group/assistant-text relative my-1 break-words"
                key={part.id || `${messageId}-text`}
            >
                <GeneratedJsonResultCard result={generatedResult} />
            </div>
        );
    }

    // A finalized text answer that ends in one fenced JSON object carries a
    // machine digest: the prose stays on the page, and the tail folds into
    // a collapsed line the reader can still open. The panels read the raw
    // text from the store, so folding the display costs them nothing.
    const trailingDigest =
        part.type === 'text' && !isStreaming && isFinalized
            ? splitTrailingJsonDigest(displayTextContent)
            : null;
    if (trailingDigest) {
        return (
            <div
                className="group/assistant-text relative my-1 break-words"
                key={part.id || `${messageId}-text`}
            >
                <MarkdownRenderer
                    content={trailingDigest.prose}
                    part={part}
                    messageId={messageId}
                    isAnimated={false}
                    isStreaming={false}
                    variant={part.type === 'reasoning' ? 'reasoning' : 'assistant'}
                    enableFileReferences={isFinalized}
                    onShowPopup={onShowPopup}
                />
                <details className="mt-1 rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 py-1.5 text-xs">
                    <summary className="cursor-pointer select-none text-muted-foreground">
                        {trailingDigest.lines === 1
                            ? t('chat.message.machineDigestSingle', { count: trailingDigest.lines })
                            : t('chat.message.machineDigestPlural', { count: trailingDigest.lines })}
                    </summary>
                    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-4">
                        {trailingDigest.digest}
                    </pre>
                </details>
            </div>
        );
    }

    return (
        <div
            className="group/assistant-text relative my-1 break-words"
            key={part.id || `${messageId}-text`}
            // The chat scroll stops following once the start of the reply
            // being written would leave the screen (useChatTimelineScroll).
            data-streaming-reply={isStreaming && part.type === 'text' ? '' : undefined}
        >
            <MarkdownRenderer
                content={displayTextContent}
                part={part}
                messageId={messageId}
                isAnimated={false}
                isStreaming={isStreaming}
                variant={part.type === 'reasoning' ? 'reasoning' : 'assistant'}
                enableFileReferences={isFinalized}
                onShowPopup={onShowPopup}
            />
        </div>
    );
};

export default React.memo(AssistantTextPart);
