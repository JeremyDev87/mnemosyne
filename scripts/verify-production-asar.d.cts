export type ProductionAsarFinding = {
  readonly markerId: string;
  readonly entry: string;
};

export declare function scanAsar(archivePath: string): readonly ProductionAsarFinding[];
