// Quill as a *view over markdown*. Only what markdown can express is offered; the
// image blot keeps the logical `asset:` reference in the document and shows a
// resolved URL on screen.
let loading = null;
let resolver = () => '';
let videoResolver = () => 'about:blank';

export function setAssetResolver(fn) {
  resolver = fn;
}

export function setVideoResolver(fn) {
  videoResolver = fn;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(s);
  });
}

export async function loadQuill() {
  if (!loading) {
    loading = loadScript('vendor/quill/quill.js').then(() => {
      const Quill = window.Quill;
      const ImageBlot = Quill.import('formats/image');
      class AssetImage extends ImageBlot {
        static create(value) {
          const node = super.create(value);
          if (typeof value === 'string' && value.startsWith('asset:')) {
            node.setAttribute('data-asset', value);
            node.setAttribute('src', resolver(value));
          }
          return node;
        }

        static value(node) {
          return node.getAttribute('data-asset') || super.value(node);
        }
      }
      Quill.register('formats/image', AssetImage, true);

      // The document keeps `video:<key>/<name>@vN`; the iframe shows the player.
      const VideoBlot = Quill.import('formats/video');
      class ReleaseVideo extends VideoBlot {
        static create(value) {
          const node = super.create(value);
          node.setAttribute('data-video', value);
          node.setAttribute('src', videoResolver(value));
          node.setAttribute('sandbox', 'allow-scripts allow-same-origin');
          node.setAttribute('referrerpolicy', 'no-referrer');
          return node;
        }

        static value(node) {
          return node.getAttribute('data-video');
        }
      }
      Quill.register('formats/video', ReleaseVideo, true);
      Quill.import('formats/link').PROTOCOL_WHITELIST.push('asset');
      return Quill;
    });
  }
  return loading;
}

export const FORMATS = ['header', 'bold', 'italic', 'strike', 'code', 'link', 'blockquote', 'code-block', 'list', 'indent', 'image', 'video'];

export async function createEditor(el, { onImage, onVideo }) {
  const Quill = await loadQuill();
  return new Quill(el, {
    theme: 'snow',
    formats: FORMATS,
    modules: {
      toolbar: {
        container: [[{ header: [2, 3, false] }], ['bold', 'italic', 'strike', 'code'], ['link'], ['blockquote', 'code-block'], [{ list: 'ordered' }, { list: 'bullet' }, { indent: '-1' }, { indent: '+1' }], ['image', 'video'], ['clean']],
        handlers: { image: onImage, video: onVideo },
      },
    },
  });
}
