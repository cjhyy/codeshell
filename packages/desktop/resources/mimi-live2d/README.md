# Optional Live2D prototype assets

The default Mimi companion uses the existing bundled sprite atlas and does not
need these resources. Its `CharacterRenderer` adapter accepts the same CUA
presentation state as the optional `Live2DActor`. Importing arbitrary character
models is not part of this prototype.

Hiyori Momose is pinned to official `CubismWebSamples` tag `4-r.7`, commit
`de9eb4bec4326b81fe67a54e84322fdc39bc7446`. `source.json` records SHA-256 and size
for every unmodified file. Generated assets stay in ignored `out/mimi-live2d`.

From `packages/desktop`, prepare the model with:

```sh
bun scripts/prepare-mimi-live2d.ts
```

The script never downloads Cubism Core. Obtain Cubism SDK for Web through the
[official download page](https://www.live2d.com/en/sdk/download/web/), review and
accept its agreements yourself, then copy Core from the extracted SDK:

```sh
bun scripts/prepare-mimi-live2d.ts --sdk /absolute/path/to/CubismSdkForWeb-4-r.7
```

This adapter targets Cubism 4, `pixi-live2d-display` 0.4.0 and PixiJS 6.5.10.
Core is loaded locally from `csmimi://assets/Core/live2dcubismcore.min.js` before
the adapter is imported; no CDN is used. Without Core, default Mimi remains
fully available. Live2D rendering requires separate validation after Core is
installed. Hiyori provides ten official motions; the adapter adds small gaze and
arm parameter gestures. It does not provide a motion-captured typing animation
or inverse-kinematic hand contact with arbitrary UI controls.

## License and attribution

Hiyori assets are separate from this repository's MIT source license. Refer to
the [official character page](https://www.live2d.com/en/learn/sample/momose-hiyori/),
[Free Material License](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)
and [Sample Model Terms](https://www.live2d.com/eula/live2d-sample-model-terms_en.html).
The free-material license permits individuals and small-scale enterprises to
use the material under its terms; use by other entities has additional scope
restrictions, including internal development/verification. Preserve the
character's design. This local prototype does not settle product distribution
or larger-entity commercial licensing.

Cubism Core is separately governed by the
[Proprietary Software License](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html).
The SDK framework is subject to the
[Open Software License](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html).
See [SDK publication licensing](https://www.live2d.com/en/sdk/license/) before
shipping; expandable applications have additional terms. Do not treat the
MIT license on the Pixi adapter or sample program as a license for Core/models.

Keep `NOTICE.txt` with any local resource copy. Retain the agreements supplied
with the downloaded SDK. The preparation script records Core's hash locally;
Core itself and downloaded model assets are not committed here.
