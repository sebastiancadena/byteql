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
      '&': { color: '#edf3f7', backgroundColor: '#0b1016' },
      '.cm-content': { caretColor: '#ffca68' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#ffca68' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
        backgroundColor: '#24514f',
      },
      '.cm-gutters': {
        color: '#aebdca',
        backgroundColor: '#111820',
        borderRightColor: '#465b6d',
      },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#17212b' },
    },
    { dark: true },
  );

  const sqlHighlightStyle = HighlightStyle.define([
    { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword], color: '#7dd3fc' },
    { tag: [tags.string, tags.special(tags.string)], color: '#a7f3d0' },
    { tag: [tags.number, tags.bool, tags.null], color: '#fde68a' },
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#aebdca' },
    { tag: [tags.operator, tags.punctuation], color: '#f0abfc' },
    { tag: [tags.name, tags.variableName, tags.propertyName], color: '#edf3f7' },
    { tag: tags.invalid, color: '#ffb4aa', textDecoration: 'underline' },
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
