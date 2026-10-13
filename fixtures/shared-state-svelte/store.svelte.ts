// Module state shared by every instance: a $state object, a $state array
// and a class with $state fields.
export const store = $state({ count: 0, names: [] as string[] });

class Tally {
  value = $state(0);
  bump() {
    this.value += 1;
  }
}

export const tally = new Tally();
