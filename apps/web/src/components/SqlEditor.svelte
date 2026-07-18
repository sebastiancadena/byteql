<script lang="ts">
  /* global HTMLDivElement */

  import { sql as sqlLanguage } from '@codemirror/lang-sql';
  import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
  import { Compartment } from '@codemirror/state';
  import { keymap } from '@codemirror/view';
  import { tags } from '@lezer/highlight';
  import { basicSetup, EditorView } from 'codemirror';
  import { onMount } from 'svelte';

  interface Props {
    sql: string;
    disabled?: boolean;
    onrun: (sql: string) => void;
    onchange?: (sql: string) => void;
  }

  let { sql, disabled = false, onrun, onchange = () => undefined }: Props = $props();
  let host: HTMLDivElement;
  let view = $state<EditorView | null>(null);
  const editable = new Compartment();

  const darkTheme = EditorView.theme(
    {
      '&': {
        color: 'var(--color-editor-text)',
        backgroundColor: 'var(--color-editor-background)',
      },
      '.cm-content': { caretColor: 'var(--color-editor-caret)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-editor-caret)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
        backgroundColor: 'var(--color-editor-selection)',
      },
      '.cm-gutters': {
        color: 'var(--color-editor-gutter-text)',
        backgroundColor: 'var(--color-editor-gutter-background)',
        borderRightColor: 'var(--color-editor-border)',
      },
      '.cm-activeLine, .cm-activeLineGutter': {
        backgroundColor: 'var(--color-editor-active-line)',
      },
    },
    { dark: true },
  );

  const sqlHighlightStyle = HighlightStyle.define([
    {
      tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword],
      color: 'var(--color-syntax-keyword)',
    },
    { tag: [tags.string, tags.special(tags.string)], color: 'var(--color-syntax-string)' },
    { tag: [tags.number, tags.bool, tags.null], color: 'var(--color-syntax-number)' },
    {
      tag: [tags.comment, tags.lineComment, tags.blockComment],
      color: 'var(--color-syntax-comment)',
    },
    { tag: [tags.operator, tags.punctuation], color: 'var(--color-syntax-operator)' },
    {
      tag: [tags.name, tags.variableName, tags.propertyName],
      color: 'var(--color-syntax-name)',
    },
    {
      tag: tags.invalid,
      color: 'var(--color-syntax-invalid)',
      textDecoration: 'underline',
    },
  ]);

  onMount(() => {
    const editor = new EditorView({
      doc: sql,
      parent: host,
      extensions: [
        keymap.of([
          {
            key: 'Mod-Enter',
            run(currentView) {
              onrun(currentView.state.doc.toString());
              return true;
            },
          },
        ]),
        basicSetup,
        sqlLanguage(),
        darkTheme,
        syntaxHighlighting(sqlHighlightStyle),
        editable.of(EditorView.editable.of(!disabled)),
        EditorView.contentAttributes.of({ 'aria-label': 'SQL query' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onchange(update.state.doc.toString());
        }),
      ],
    });
    view = editor;

    return () => {
      editor.destroy();
      if (view === editor) view = null;
    };
  });

  $effect(() => {
    const editor = view;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== sql) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: sql } });
    }
  });

  $effect(() => {
    const editor = view;
    if (!editor) return;
    editor.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!disabled)) });
  });
</script>

<div class="sql-editor" class:disabled bind:this={host}></div>
