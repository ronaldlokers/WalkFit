import js from '@eslint/js'
import vue from 'eslint-plugin-vue'
import globals from 'globals'
import prettier from 'eslint-config-prettier'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'

export default defineConfigWithVueTs(
  { ignores: ['dist/', 'node_modules/'] },
  js.configs.recommended,
  vue.configs['flat/recommended'],
  vueTsConfigs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // TEMP during the #28 JS->TS migration: SFC script blocks convert to lang="ts"
      // in their own steps; drop allowNoLang once App.vue and WorkoutPicker.vue are TS.
      'vue/block-lang': ['error', { script: { lang: 'ts', allowNoLang: true } }],
    },
  },
)
