import conventional from '@commitlint/config-conventional';

const [level, applicable, types] = conventional.rules['type-enum'];

/** Dependabot capitalizes "Bump" in group pull request titles, whatever the repository's style. */
const DEPENDABOT_GROUP = /^build\(deps(-dev)?\): Bump the "[\w-]+" group /;

export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [(message) => DEPENDABOT_GROUP.test(message)],
  rules: {
    'type-enum': [level, applicable, [...types, 'release']],
  },
};
