<script setup lang="ts">
import { reactive, watch } from 'vue';
import { NModal, NCard, NForm, NFormItem, NInputNumber, NButton, NSpace, NText } from 'naive-ui';
import type { Pricing } from '@/types';

const props = defineProps<{
  show: boolean;
  provider: string;
  model: string;
  pricing?: Pricing;
}>();

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void;
  (e: 'save', pricing: Pricing): void;
}>();

const empty: Pricing = { input: 0, cacheRead: 0, output: 0, reasoning: 0, cacheWrite: 0, multiplier: 1 };
const form = reactive<Pricing>({ ...empty });

watch(
  () => props.show,
  (v) => {
    if (v) Object.assign(form, props.pricing ?? empty);
  },
);

function save() {
  emit('save', { ...form });
  emit('update:show', false);
}

function close() {
  emit('update:show', false);
}
</script>

<template>
  <NModal :show="props.show" @update:show="close" :auto-focus="false">
    <NCard
      style="width: 480px"
      :title="`定价设置 — ${props.provider} / ${props.model}`"
      :bordered="false"
      size="small"
      role="dialog"
      closable
      @close="close"
    >
      <NText depth="3" style="display: block; margin-bottom: 16px">
        价格单位：人民币 / 百万 Token
      </NText>
      <NForm label-placement="left" label-width="100px">
        <NFormItem label="输入 Token"><NInputNumber v-model:value="form.input" :min="0" :show-button="false" style="width: 100%" /></NFormItem>
        <NFormItem label="缓存读取"><NInputNumber v-model:value="form.cacheRead" :min="0" :show-button="false" style="width: 100%" /></NFormItem>
        <NFormItem label="输出 Token"><NInputNumber v-model:value="form.output" :min="0" :show-button="false" style="width: 100%" /></NFormItem>
        <NFormItem label="思考"><NInputNumber v-model:value="form.reasoning" :min="0" :show-button="false" style="width: 100%" /></NFormItem>
        <NFormItem label="缓存写入"><NInputNumber v-model:value="form.cacheWrite" :min="0" :show-button="false" style="width: 100%" /></NFormItem>
        <NFormItem label="倍率"><NInputNumber v-model:value="form.multiplier" :min="0" :show-button="false" style="width: 100%" /></NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="close">取消</NButton>
          <NButton type="primary" @click="save">保存</NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>
