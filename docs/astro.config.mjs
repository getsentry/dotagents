import starlight from "@astrojs/starlight";
import sentryStarlightTheme, {
  monochromeCodeTheme,
} from "@sentry/starlight-theme";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://dotagents.sentry.dev",
  devToolbar: { enabled: false },
  integrations: [
    starlight({
      title: "dotagents",
      description: "Shared tooling for coding agents.",
      customCss: ["./src/styles/dotagents.css"],
      pagination: true,
      sidebar: [
        {
          label: "Documentation",
          items: [
            { label: "Overview", link: "/" },
            { label: "Guide", link: "/guide/" },
            { label: "CLI", link: "/cli/" },
            { label: "Security", link: "/security/" },
          ],
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/getsentry/dotagents",
        },
      ],
      plugins: [sentryStarlightTheme()],
    }),
  ],
  markdown: {
    // Astro 6.4 left markdown.gfm optional/undefined. MDX still gates
    // remark-gfm on this flag, so pipe tables render as plain text without it.
    gfm: true,
    shikiConfig: {
      theme: monochromeCodeTheme,
    },
  },
});
