module.exports = {
  env: {
    browser: true,
    es2021: true,
    mocha: true,
  },
  extends: ['airbnb-base', 'plugin:import/typescript'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  rules: {
    'import/extensions': 0,
    'import/no-extraneous-dependencies': 0,
    'import/no-unresolved': 0,
    'no-restricted-syntax': 0,
    'no-await-in-loop': 0,
    'no-console': 0,
    'no-bitwise': 0,
    'no-plusplus': 0,
    'no-continue': 0,
    'no-promise-executor-return': 0,
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    // https://github.com/typescript-eslint/tslint-to-eslint-config/issues/856
    'no-shadow': 0,
    'lines-between-class-members': [
      'error',
      'always',
      { exceptAfterSingleLine: true },
    ],
  },
};
