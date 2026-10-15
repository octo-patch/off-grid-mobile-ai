import React, { useCallback, useMemo } from 'react';
import { View, Text } from 'react-native';
import { splitCitations } from '@offgrid/rag/documents';
import { ThinkingIndicator } from '../../ThinkingIndicator';
import { MarkdownText } from '../../MarkdownText';
import { BlinkingCursor } from './BlinkingCursor';
import { ThinkingBlock } from './ThinkingBlock';
import type { ParsedContent } from '../types';
import type { DocumentCitation } from '../../../types';

const CITATION_SCHEME = 'offgrid-doc:';

/** `[S#]` tags become page links ("p. 214") that open the cited page; unknown tags are dropped. */
function citedMarkdown(text: string, sources: DocumentCitation[]): string {
  return splitCitations(text)
    .map((segment) => {
      if (segment.kind === 'text') return segment.text;
      const source = sources[segment.index - 1];
      if (!source) return '';
      const label = (source.label ?? `p. ${source.page}`).replace(/[[\]]/g, '');
      return `[${label}](${CITATION_SCHEME}${segment.index})`;
    })
    .join('');
}

interface MessageContentProps {
  isUser: boolean;
  isThinking?: boolean;
  content: string;
  isStreaming?: boolean;
  parsedContent: ParsedContent;
  showThinking: boolean;
  onToggleThinking: () => void;
  styles: any;
  /** Passages the answer may cite as [S#]. */
  documentSources?: DocumentCitation[];
  onCitationPress?: (source: DocumentCitation) => void;
}

export function MessageContent({
  isUser,
  isThinking,
  content,
  isStreaming,
  parsedContent,
  showThinking,
  onToggleThinking,
  styles,
  documentSources,
  onCitationPress,
}: Readonly<MessageContentProps>) {
  const response = parsedContent.response;
  const answer = useMemo(
    () => (!isUser && response && documentSources?.length ? citedMarkdown(response, documentSources) : response),
    [documentSources, isUser, response],
  );
  const handleAppLink = useCallback(
    (url: string) => {
      if (!url.startsWith(CITATION_SCHEME)) return false;
      const source = documentSources?.[Number(url.slice(CITATION_SCHEME.length)) - 1];
      if (source) onCitationPress?.(source);
      return true;
    },
    [documentSources, onCitationPress],
  );

  if (isThinking) {
    return (
      <View testID="thinking-indicator">
        <ThinkingIndicator text={content} />
      </View>
    );
  }

  // If no content yet but we have live reasoning tokens, show the thinking block so
  // reasoning streams incrementally rather than appearing all at once when content arrives.
  if (!content && isStreaming && parsedContent.thinking) {
    return (
      <View>
        <ThinkingBlock
          parsedContent={parsedContent}
          showThinking={showThinking}
          onToggle={onToggleThinking}
          styles={styles}
        />
        <View testID="streaming-thinking-hint" style={styles.streamingThinkingHint}>
          <ThinkingIndicator />
        </View>
      </View>
    );
  }

  if (!content) {
    if (isStreaming) {
      return (
        <Text testID="message-text" style={[styles.text, styles.assistantText]}>
          <BlinkingCursor />
        </Text>
      );
    }
    // No content but may have thinking — render ThinkingBlock alone (audio mode above-bubble use case)
    if (parsedContent.thinking) {
      return (
        <ThinkingBlock
          parsedContent={parsedContent}
          showThinking={showThinking}
          onToggle={onToggleThinking}
          styles={styles}
        />
      );
    }
    return null;
  }

  return (
    <View>
      {!!parsedContent.thinking && (
        <ThinkingBlock
          parsedContent={parsedContent}
          showThinking={showThinking}
          onToggle={onToggleThinking}
          styles={styles}
        />
      )}

      {(() => {
        if (parsedContent.response) {
          if (isUser) {
            return (
              <Text
                testID="message-text"
                style={[styles.text, styles.userText]}
                selectable
              >
                {parsedContent.response}
              </Text>
            );
          }
          return (
            <View testID="message-text">
              <MarkdownText onAppLink={handleAppLink}>{answer}</MarkdownText>
              {isStreaming && <BlinkingCursor />}
            </View>
          );
        }
        if (isStreaming && !parsedContent.isThinkingComplete) {
          return (
            <View testID="streaming-thinking-hint" style={styles.streamingThinkingHint}>
              <ThinkingIndicator />
            </View>
          );
        }
        if (isStreaming) {
          return (
            <Text testID="message-text" style={[styles.text, styles.assistantText]}>
              <BlinkingCursor />
            </Text>
          );
        }
        return null;
      })()}
    </View>
  );
}
