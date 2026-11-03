<script lang="ts">
  import Reader from '../../src/views/Reader.svelte';
  let chapterId = $state('fixture:chapter');
  export function changeChapter(id: string): void { chapterId = id; }
</script>
<Reader seriesId="fixture:series" {chapterId} />
