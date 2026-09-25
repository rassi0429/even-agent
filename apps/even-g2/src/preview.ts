import { frameIndex, type Scene } from '@even-agent/protocol';
// Browser approximation; native firmware controls the actual font and wrapping.
export function renderPreview(
  screen: HTMLElement,
  text: string,
  scene: Scene | undefined,
  elapsed: number,
  online: boolean,
) {
  screen.setAttribute('aria-label', text);
  screen.classList.toggle('scene-preview', !!scene);
  if (!scene) {
    screen.textContent = text;
    return;
  }
  const surface = document.createElement('span');
  surface.className = 'scene-surface';
  surface.style.transform = `scale(${screen.clientWidth / 576})`;
  for (const element of scene.elements) {
    let node: HTMLElement;
    if (element.type === 'image') {
      const canvas = document.createElement('canvas');
      canvas.width = element.width;
      canvas.height = element.height;
      const context = canvas.getContext('2d');
      if (context) {
        const image = context.createImageData(element.width, element.height);
        const hex = element.frames[frameIndex(element, elapsed, online)]!;
        for (let i = 0; i < hex.length; i++) {
          const level = parseInt(hex[i]!, 16) / 15;
          image.data.set([189 * level, 235 * level, 167 * level, 255], i * 4);
        }
        context.putImageData(image, 0, 0);
      }
      canvas.setAttribute('aria-hidden', 'true');
      node = canvas;
    } else {
      node = document.createElement('span');
      node.textContent = element.text;
      node.style.padding = `${element.padding}px`;
      node.style.border = `${element.border}px solid currentColor`;
      node.style.color = `rgb(${(189 * element.brightness) / 4}, ${(235 * element.brightness) / 4}, ${(167 * element.brightness) / 4})`;
      node.className = 'scene-text';
    }
    Object.assign(node.style, {
      position: 'absolute',
      left: `${element.x}px`,
      top: `${element.y}px`,
      width: `${element.width}px`,
      height: `${element.height}px`,
    });
    surface.append(node);
  }
  screen.replaceChildren(surface);
}
