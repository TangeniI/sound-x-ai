# Contributing

Thanks for taking a look. Bug reports, ideas and pull requests are all welcome.

- **Something broken?** Open an [issue](https://github.com/TangeniI/sound-x-ai/issues/new/choose)
  with your browser, what you did and what you heard or saw. A share link from the studio
  helps a lot: it rebuilds the exact take.
- **An idea, a question, or something you made?** Post it in
  [Discussions](https://github.com/TangeniI/sound-x-ai/discussions).

## Working on the code

```bash
npm install
npm run dev      # http://localhost:5173
npm test
npm run build    # typecheck + production build
```

CI runs the tests and the build on every pull request. Before you open one:

- Keep each pull request to one change, and add a test for anything the engine or the
  exports do differently.
- Check audio changes by rendering and measuring, not only by ear: the README's
  [Sound quality](README.md#sound-quality) section says how.
- New recordings need a licence that allows redistribution, credited in
  [SOURCES.md](public/samples/SOURCES.md). Don't add audio taken from released records,
  not even short samples.

By contributing you agree your code is released under the [MIT licence](LICENSE).
