document.documentElement.dataset.scheme = matchMedia('(prefers-color-scheme: dark)').matches
  ? 'dark'
  : 'light';
