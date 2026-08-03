<script setup lang="ts">
import { reactive, watch } from 'vue';
import { NModal, NCard, NForm, NFormItem, NInputNumber, NInput, NButton, NSpace, NText } from 'naive-ui';
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

const empty: Pricing = { input: 0, cacheRead: 0, output: 0, reasoning: 0, cacheWrite: 0, multiplier: 1, peakMultiplier: 1, peakTimes: [], peakDates: [] };
const form = reactive<Pricing>({ ...empty });

watch(
  () => props.show,
  (v) => {
    if (v) {
      // 先重置为空模板再覆盖，避免旧数据缺字段时残留上一行配置
      Object.assign(form, empty, props.pricing ?? {});
      form.peakTimes = Array.isArray(form.peakTimes) ? [...form.peakTimes] : [];
      form.peakDates = Array.isArray(form.peakDates) ? [...form.peakDates] : [];
    }
  },
);

function save() {
  // 过滤空白行，兼容旧数据 peakTimes 为空
  emit('save', {
    ...form,
    peakTimes: form.peakTimes.map((s) => s.trim()).filter(Boolean),
    peakDates: form.peakDates.map((s) => s.trim()).filter(Boolean),
  });
  emit('update:show', false);
}

function addPeak() {
  form.peakTimes.push('');
}

function removePeak(i: number) {
  form.peakTimes.splice(i, 1);
}

function addPeakDate() {
  form.peakDates.push('');
}

function removePeakDate(i: number) {
  form.peakDates.splice(i, 1);
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
        <NFormItem label="高峰倍率"><NInputNumber v-model:value="form.peakMultiplier" :min="0" :show-button="false" style="width: 100%" /></NFormItem>
        <NFormItem label="高峰时间段">
          <div style="width: 100%">
            <div v-for="(_, i) in form.peakTimes" :key="i" style="display: flex; gap: 8px; margin-bottom: 8px">
              <NInput v-model:value="form.peakTimes[i]" placeholder="HH:mm-HH:mm，支持跨天" />
              <NButton size="small" quaternary type="error" @click="removePeak(i)">移除</NButton>
            </div>
            <NButton size="tiny" quaternary type="primary" @click="addPeak">添加时间段</NButton>
          </div>
        </NFormItem>
        <NFormItem label="启用日期">
          <div style="width: 100%">
            <div v-for="(_, i) in form.peakDates" :key="i" style="display: flex; gap: 8px; margin-bottom: 8px">
              <NInput v-model:value="form.peakDates[i]" placeholder="如 2025.11.1-* 或 *-2025.11.1" />
              <NButton size="small" quaternary type="error" @click="removePeakDate(i)">移除</NButton>
            </div>
            <NButton size="tiny" quaternary type="primary" @click="addPeakDate">添加日期区间</NButton>
          </div>
        </NFormItem>
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
