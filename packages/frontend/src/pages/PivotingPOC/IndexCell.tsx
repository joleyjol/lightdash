import { FC } from 'react';
import { useStyles } from './UseStyles';

type IndexCellProps = {
    label: string | undefined;
};
const IndexCell: FC<IndexCellProps> = ({ label }) => {
    const { classes } = useStyles();
    return <td className={classes.header}>{label || '-'}</td>;
};

export default IndexCell;