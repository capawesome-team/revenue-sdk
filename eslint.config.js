import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'docs', 'pages', '.blume', '.blume-dist', '.astro'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,
);
