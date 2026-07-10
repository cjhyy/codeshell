import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "./Composer";

test("Composer exposes gallery/camera inputs and image-only capable controls", () => {
  const html = renderToStaticMarkup(
    <Composer disabled={false} running={false} onSend={async () => true} onStop={() => {}} />,
  );
  expect(html.match(/type="file"/g)).toHaveLength(2);
  expect(html).toContain('accept="image/*"');
  expect(html).toContain('capture="environment"');
  expect(html).toContain('aria-label="从相册选择图片"');
  expect(html).toContain('aria-label="拍照"');
});
