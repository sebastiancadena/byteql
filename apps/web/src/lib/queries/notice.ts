/** A short-lived message from the query library, optionally with an Undo action. */
export interface LibraryNotice {
  message: string;
  undo?: () => void;
}
