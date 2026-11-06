// Where an embed goes in the editor. After a dialog or a long upload the editor may have lost its
// selection, and getSelection(true) can still return null (seen in the VS Code browser): fall back
// to the end of the document instead of throwing, so the work already done (a published release,
// an upload) is not wasted on a missing cursor.
export function insertionPoint(quill) {
  return quill.getSelection(true) || { index: Math.max(0, quill.getLength() - 1) };
}
