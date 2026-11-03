import conventional from '@commitlint/config-conventional';

const [level, applicable, types] = conventional.rules['type-enum'];

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [level, applicable, [...types, 'release']],
  },
};
