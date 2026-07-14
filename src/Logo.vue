<script setup lang="ts">
// Reusable brand lockup: the 400 m-track mark + "WalkFit" wordmark.
// Scales off `size` (wordmark px height); the mark keeps its proportion.
// The standalone mark also lives in public/favicon.svg — keep the two in sync.
withDefaults(defineProps<{ size?: number; mark?: boolean }>(), { size: 26, mark: true })
</script>

<template>
  <span class="logo" :style="{ fontSize: size + 'px' }">
    <svg v-if="mark" class="logo-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect
        x="3"
        y="8"
        width="26"
        height="16"
        rx="8"
        fill="none"
        stroke="var(--accent)"
        stroke-width="2.6"
      />
      <rect
        x="8.5"
        y="13"
        width="15"
        height="6"
        rx="3"
        fill="none"
        stroke="var(--accent)"
        stroke-width="1.4"
        opacity="0.45"
      />
      <circle cx="16" cy="24" r="2.8" fill="var(--accent)" />
    </svg>
    <span class="logo-word">Walk<span class="logo-fit">Fit</span></span>
  </span>
</template>

<style scoped>
.logo {
  display: inline-flex;
  align-items: center;
  gap: 0.32em;
  line-height: 1;
  white-space: nowrap;
}
.logo-mark {
  width: 1.15em;
  height: 1.15em;
  flex: none;
}
.logo-word {
  font-weight: 800;
  letter-spacing: -0.02em;
  color: #e8ecf2;
}
.logo-fit {
  color: var(--accent);
}
</style>
