import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import prettier from 'eslint-config-prettier/flat';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // 页面和组件不直接查数据库，必须经过 src/server/ 的数据访问层（带 household_id）
  {
    files: ['src/app/**', 'src/components/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(@/db|.*/db)(/.*)?$',
              message: '不要在页面和组件里直接用数据库，改用 src/server/ 下的函数',
            },
          ],
        },
      ],
    },
  },
  // 放最后：关掉所有和 Prettier 冲突的格式规则
  prettier,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
]);

export default eslintConfig;
