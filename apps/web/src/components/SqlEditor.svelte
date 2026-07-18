<script lang="ts">
  /* global HTMLDivElement */

  import { sql as sqlLanguage } from '@codemirror/lang-sql';
  import { keymap } from '@codemirror/view';
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
        EditorView.editable.of(!disabled),
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
</script>

<div class="sql-editor" class:disabled bind:this={host}></div>
